import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const cronSecret = Deno.env.get('CRON_SECRET')
    const cronHeader = req.headers.get('x-cron-key')
    const isCron = !!(cronSecret && cronHeader && cronHeader === cronSecret)

    if (!isCron) {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders })

      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!)
      const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
      if (authError || !user) return new Response(JSON.stringify({ error: 'Unauthorized', detail: authError?.message }), { status: 401, headers: corsHeaders })
    }

    const sbAdmin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: setting } = await sbAdmin.from('app_settings').select('value').eq('key', 'mailchimp_api_key').single()
    const MC_KEY = setting?.value
    if (!MC_KEY) return new Response(JSON.stringify({ error: 'Mailchimp API key not configured' }), { status: 400, headers: corsHeaders })

    const dc = MC_KEY.split('-')[1] || 'us5'
    const MC_BASE = `https://${dc}.api.mailchimp.com/3.0`
    const authB64 = btoa(`anystring:${MC_KEY}`)

    const body = await req.json()
    const { action } = body

    const mcFetch = async (path: string, method = 'GET', data?: unknown) => {
      const res = await fetch(`${MC_BASE}${path}`, {
        method,
        headers: { 'Authorization': `Basic ${authB64}`, 'Content-Type': 'application/json' },
        body: data ? JSON.stringify(data) : undefined,
      })
      return res.json()
    }

    // ── GET SETTINGS ──────────────────────────────────────────
    if (action === 'get_settings') {
      const { data } = await sbAdmin.from('app_settings').select('value').eq('key', 'mc_settings').single()
      try { return new Response(JSON.stringify(data?.value ? JSON.parse(data.value) : { main_list_id: '', tag_lists: {} }), { headers: corsHeaders }) }
      catch(e) { return new Response(JSON.stringify({ main_list_id: '', tag_lists: {} }), { headers: corsHeaders }) }
    }

    if (action === 'set_main_list') {
      const { listId } = body
      const { data: cur } = await sbAdmin.from('app_settings').select('value').eq('key', 'mc_settings').single()
      const settings = cur?.value ? JSON.parse(cur.value) : { tag_lists: {} }
      settings.main_list_id = listId
      await sbAdmin.from('app_settings').upsert({ key: 'mc_settings', value: JSON.stringify(settings) }, { onConflict: 'key' })
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders })
    }

    if (action === 'set_tag_list') {
      const { tag, listId } = body
      const { data: cur } = await sbAdmin.from('app_settings').select('value').eq('key', 'mc_settings').single()
      const settings = cur?.value ? JSON.parse(cur.value) : { tag_lists: {} }
      if (!settings.tag_lists) settings.tag_lists = {}
      if (listId) settings.tag_lists[tag] = listId
      else delete settings.tag_lists[tag]
      await sbAdmin.from('app_settings').upsert({ key: 'mc_settings', value: JSON.stringify(settings) }, { onConflict: 'key' })
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders })
    }

    // ── GET LISTS ─────────────────────────────────────────────
    if (action === 'get_lists') {
      const data = await mcFetch('/lists?count=100')
      return new Response(JSON.stringify(data), { headers: corsHeaders })
    }

    // ── CREATE LIST ───────────────────────────────────────────
    if (action === 'create_list') {
      const data = await mcFetch('/lists', 'POST', {
        name: body.listName,
        contact: { company: 'Full Pot of Flowers', address1: 'Orlando', city: 'Orlando', state: 'FL', zip: '32801', country: 'US' },
        permission_reminder: 'You are receiving this email because you opted in.',
        campaign_defaults: { from_name: 'Full Pot of Flowers', from_email: 'info@fullpot.com', subject: '', language: 'en' },
        email_type_option: false,
      })
      return new Response(JSON.stringify(data), { headers: corsHeaders })
    }

    // ── BATCH MEMBERS ─────────────────────────────────────────
    if (action === 'batch_members_direct') {
      const { listId, members, tag } = body
      if (!listId || !members?.length) return new Response(JSON.stringify({ error: 'Missing listId or members' }), { status: 400, headers: corsHeaders })

      const batchData = await mcFetch(`/lists/${listId}`, 'POST', {
        members: members.map((m: any) => ({ ...m, status_if_new: 'subscribed' })),
        update_existing: true,
      })

      if (tag && tag.trim()) {
        const tagName = tag.trim()
        const allEmails = members.map((m: any) => m.email_address).filter(Boolean)
        // Apply tags synchronously in small batches of 10
        for (let ti = 0; ti < allEmails.length; ti += 10) {
          const batch = allEmails.slice(ti, ti + 10)
          await Promise.all(batch.map(async (email: string) => {
            try {
              const hash = await md5(email.toLowerCase().trim())
              await mcFetch(`/lists/${listId}/members/${hash}/tags`, 'POST', {
                tags: [{ name: tagName, status: 'active' }],
              })
            } catch (_) {}
          }))
        }
        batchData.tag_applied = tagName
        batchData.tag_count = allEmails.length
      }

      batchData.debug = `listId=${listId} count=${members.length} tag=${tag || 'none'}`
      return new Response(JSON.stringify(batchData), { headers: corsHeaders })
    }

    // ── SYNC CONTACT ──────────────────────────────────────────
    if (action === 'sync_contact') {
      const { lead } = body
      if (!lead?.email) return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders })
      const hash = await md5(lead.email.toLowerCase().trim())
      await mcFetch(`/lists/e2f2a95258/members/${hash}`, 'PUT', {
        email_address: lead.email,
        status_if_new: 'subscribed',
        merge_fields: { FNAME: (lead.contact||'').split(' ')[0]||'', LNAME: (lead.contact||'').split(' ').slice(1).join(' ')||'', COMPANY: lead.company||'' },
      }).catch(() => null)
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders })
    }

    // ── ARCHIVE CONTACT ───────────────────────────────────────
    if (action === 'archive_contact') {
      const { email } = body
      if (!email) return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders })
      const hash = await md5(email.toLowerCase().trim())
      await mcFetch(`/lists/e2f2a95258/members/${hash}`, 'DELETE').catch(() => null)
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders })
    }

    // ── GET CAMPAIGNS ─────────────────────────────────────────
    if (action === 'get_campaigns') {
      const data = await mcFetch('/campaigns?count=50&sort_field=send_time&sort_dir=DESC')
      return new Response(JSON.stringify(data), { headers: corsHeaders })
    }

    // ── GET CAMPAIGN ACTIVITY ─────────────────────────────────
    if (action === 'get_campaign_activity') {
      const { campaignId } = body
      const data = await mcFetch(`/reports/${campaignId}`)
      return new Response(JSON.stringify(data), { headers: corsHeaders })
    }

    // ── SET COLD CONFIG ───────────────────────────────────────
    if (action === 'set_cold_config') {
      const { listId, tagName } = body
      const { data: cur } = await sbAdmin.from('app_settings').select('value').eq('key', 'mc_settings').single()
      const settings = cur?.value ? JSON.parse(cur.value) : { tag_lists: {} }
      if (listId !== undefined) settings.cold_list_id = listId
      if (tagName !== undefined) settings.cold_tag_name = tagName
      await sbAdmin.from('app_settings').upsert({ key: 'mc_settings', value: JSON.stringify(settings) }, { onConflict: 'key' })
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders })
    }

    // ── IMPORT COLD LEADS ─────────────────────────────────────
    if (action === 'import_cold_leads') {
      const { data: cur } = await sbAdmin.from('app_settings').select('value').eq('key', 'mc_settings').single()
      const settings = cur?.value ? JSON.parse(cur.value) : {}
      const listId = body.listId || settings.cold_list_id
      const tagName = String(body.tagName || settings.cold_tag_name || 'cold lead').toLowerCase().trim()
      const responsible = body.responsible || 'Rafael Chaves'
      const segmentation = body.segmentation || 'COLD LEAD'

      if (!listId) {
        return new Response(JSON.stringify({ error: 'cold_list_id not configured. Set audience first.' }), { status: 400, headers: corsHeaders })
      }

      // Find the static segment whose name matches the tag (Mailchimp exposes tags as static segments)
      const segData = await mcFetch(`/lists/${listId}/segments?type=static&count=1000`)
      const seg = (segData.segments || []).find((s: any) => String(s.name || '').toLowerCase().trim() === tagName)
      if (!seg) {
        return new Response(JSON.stringify({ error: `Tag "${tagName}" not found in list ${listId}`, imported: [], skipped: 0, total: 0 }), { headers: corsHeaders })
      }

      // Paginate members of that segment
      const members: any[] = []
      let offset = 0
      const pageSize = 1000
      while (true) {
        const data = await mcFetch(`/lists/${listId}/segments/${seg.id}/members?count=${pageSize}&offset=${offset}&fields=members.email_address,members.merge_fields,members.timestamp_signup,members.status`)
        const batch = data.members || []
        members.push(...batch)
        if (batch.length < pageSize) break
        offset += pageSize
        if (offset > 50000) break // safety
      }

      const candidates = members.filter((m: any) => m.email_address && (m.status === 'subscribed' || !m.status))

      // Lookup existing emails
      const emails = candidates.map((m: any) => String(m.email_address).toLowerCase())
      let existingSet = new Set<string>()
      if (emails.length) {
        const { data: existing } = await sbAdmin.from('leads').select('email').in('email', emails)
        existingSet = new Set((existing || []).map((r: any) => String(r.email || '').toLowerCase()))
        // Also check raw-cased emails (in case stored unlowercased)
        const rawEmails = candidates.map((m: any) => m.email_address)
        const { data: existing2 } = await sbAdmin.from('leads').select('email').in('email', rawEmails)
        ;(existing2 || []).forEach((r: any) => existingSet.add(String(r.email || '').toLowerCase()))
      }

      // Get next ID
      const { data: maxRows } = await sbAdmin.from('leads').select('id').order('id', { ascending: false }).limit(1)
      let nextId = ((maxRows && maxRows[0]?.id) || 0) + 1

      const imported: any[] = []
      const nowIso = new Date().toISOString()

      for (const m of candidates) {
        const email = String(m.email_address).toLowerCase()
        if (existingSet.has(email)) continue
        const fname = (m.merge_fields?.FNAME || '').trim()
        const lname = (m.merge_fields?.LNAME || '').trim()
        const contact = (fname + ' ' + lname).trim() || null
        const company = (m.merge_fields?.COMPANY || m.merge_fields?.MMERGE5 || contact || email.split('@')[0]).toString().trim()
        const phone = m.merge_fields?.PHONE || null
        const id = nextId++

        const leadRow: any = {
          id,
          company,
          contact,
          email: m.email_address,
          phone,
          pipeline: segmentation,
          responsible,
        }
        const { error: leadErr } = await sbAdmin.from('leads').insert(leadRow)
        if (leadErr) {
          // Likely duplicate id race or constraint; skip
          continue
        }

        await sbAdmin.from('lead_states').insert({
          lead_id: id,
          responsible,
          cs: 'novo',
          tags: [],
          mkt_tag: JSON.stringify(['Cold']),
          priority: false,
          call_count: 0,
          timeline: [{ ts: nowIso, v: 'Mailchimp Sync', txt: '📥 Imported from Mailchimp · tag "' + tagName + '"', type: 'cold_import' }],
          updated_at: nowIso,
        })

        imported.push({ id, email: m.email_address, contact, company })
        existingSet.add(email)
      }

      // Ensure segmentation exists
      const { data: segCur } = await sbAdmin.from('app_settings').select('value').eq('key', 'segmentations').single()
      let segArr: string[] = []
      try { segArr = segCur?.value ? JSON.parse(segCur.value) : [] } catch (_) { segArr = [] }
      if (!segArr.includes(segmentation)) {
        segArr.push(segmentation)
        segArr.sort()
        await sbAdmin.from('app_settings').upsert({ key: 'segmentations', value: JSON.stringify(segArr) }, { onConflict: 'key' })
      }

      // Track last sync timestamp
      await sbAdmin.from('app_settings').upsert({ key: 'mc_cold_last_sync', value: nowIso }, { onConflict: 'key' })

      return new Response(JSON.stringify({ ok: true, imported, skipped: candidates.length - imported.length, total: candidates.length, segment: seg.name }), { headers: corsHeaders })
    }

    // ── SET TAG ───────────────────────────────────────────────
    if (action === 'set_tag') {
      const { listId, email, tagName, status } = body
      const hash = await md5(email.toLowerCase().trim())
      const data = await mcFetch(`/lists/${listId}/members/${hash}/tags`, 'POST', {
        tags: [{ name: tagName, status: status || 'active' }],
      })
      return new Response(JSON.stringify(data), { headers: corsHeaders })
    }

    return new Response(JSON.stringify({ error: 'Unknown action: ' + action }), { status: 400, headers: corsHeaders })

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders })
  }
})

async function md5(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message)
  const hashBuffer = await crypto.subtle.digest('MD5', msgBuffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}
