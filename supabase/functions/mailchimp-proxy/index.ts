import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders })

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!)
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
    if (authError || !user) return new Response(JSON.stringify({ error: 'Unauthorized', detail: authError?.message }), { status: 401, headers: corsHeaders })

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

    if (action === 'get_lists') {
      const data = await mcFetch('/lists?count=100')
      return new Response(JSON.stringify(data), { headers: corsHeaders })
    }

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

    if (action === 'batch_members_direct') {
      const { listId, members, tag } = body
      if (!listId || !members?.length) return new Response(JSON.stringify({ error: 'Missing listId or members' }), { status: 400, headers: corsHeaders })

      // 1. Batch upsert members
      const batchData = await mcFetch(`/lists/${listId}`, 'POST', {
        members: members.map((m: any) => ({ ...m, status_if_new: 'subscribed' })),
        update_existing: true,
      })

      // 2. Apply tag to all members if provided
      if (tag && tag.trim()) {
        const tagName = tag.trim()
        const allEmails = members.map((m: any) => m.email_address).filter(Boolean)

        // Apply tag per member in chunks of 50
        const CHUNK = 50
        for (let i = 0; i < allEmails.length; i += CHUNK) {
          const chunk = allEmails.slice(i, i + CHUNK)
          await Promise.all(chunk.map(async (email: string) => {
            try {
              const hash = await md5(email.toLowerCase().trim())
              await mcFetch(`/lists/${listId}/members/${hash}/tags`, 'POST', {
                tags: [{ name: tagName, status: 'active' }],
              })
            } catch (_) { /* ignore per-member errors */ }
          }))
        }

        batchData.tag_applied = tagName
        batchData.tag_count = allEmails.length
      }

      batchData.debug = `listId=${listId} count=${members.length} first_email=${members[0]?.email_address} tag=${tag || 'none'}`
      return new Response(JSON.stringify(batchData), { headers: corsHeaders })
    }

    if (action === 'get_campaigns') {
      const data = await mcFetch('/campaigns?count=50&sort_field=send_time&sort_dir=DESC')
      return new Response(JSON.stringify(data), { headers: corsHeaders })
    }

    if (action === 'get_campaign_activity') {
      const { campaignId } = body
      const data = await mcFetch(`/reports/${campaignId}`)
      return new Response(JSON.stringify(data), { headers: corsHeaders })
    }

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
