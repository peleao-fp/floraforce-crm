// ============================================================
// FloraForce — Intermedia Call Sync
// ============================================================
const fetch = require('node-fetch');

const INTERMEDIA_CLIENT_ID     = process.env.INTERMEDIA_CLIENT_ID;
const INTERMEDIA_CLIENT_SECRET = process.env.INTERMEDIA_CLIENT_SECRET;
const INTERMEDIA_ACCOUNT_ID    = process.env.INTERMEDIA_ACCOUNT_ID;
const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY     = process.env.SUPABASE_SERVICE_KEY;

// ── 1. AUTH ───────────────────────────────────────────────────
async function getAccessToken() {
  const url  = 'https://login.intermedia.net/user/connect/token';
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     INTERMEDIA_CLIENT_ID,
    client_secret: INTERMEDIA_CLIENT_SECRET,
    scope:         'api.service.analytics.main'
  }).toString();

  console.log('🔑 Getting token...');
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  console.log('✅ Token obtained!');
  return data.access_token;
}

// ── 2. CALL LOGS ──────────────────────────────────────────────
async function getCallLogs(token) {
  const dateTo   = new Date();
  const dateFrom = new Date(dateTo.getTime() - 2 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    dateFrom: dateFrom.toISOString(),
    dateTo:   dateTo.toISOString()
  });

  const url = `https://api.intermedia.net/analytics/calls/user?${params}`;
  console.log(`📞 Fetching calls: ${dateFrom.toISOString()} → ${dateTo.toISOString()}`);

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    },
    body: JSON.stringify({})
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Call logs failed: ${res.status} ${err}`);
  }

  const data = await res.json();

  // DEBUG: show raw response structure
  console.log('📦 Raw response type:', typeof data);
  if (Array.isArray(data)) {
    console.log(`📦 Array with ${data.length} items`);
    if (data.length > 0) console.log('📦 First item keys:', Object.keys(data[0]).join(', '));
  } else {
    console.log('📦 Object keys:', Object.keys(data).join(', '));
    const nested = data.calls || data.items || data.records || data.data || data.results;
    if (nested) console.log(`📦 Nested array "${Object.keys(data).find(k=>Array.isArray(data[k]))}" has ${nested.length} items`);
  }

  // Response format: { calls: [...], totalCalls: N }
  const calls = data.calls || data.items || data.records || data.data || data.results
    || (Array.isArray(data) ? data : []);

  console.log(`📞 Retrieved ${calls.length} calls`);

  // DEBUG: show first few calls with all their fields
  if (calls.length > 0) {
    calls.slice(0, 3).forEach((c, i) => {
      console.log(`  Call ${i+1}:`, JSON.stringify(c).substring(0, 300));
    });
  }

  return calls;
}

// ── 3. LEADS ──────────────────────────────────────────────────
async function getLeads() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/leads?select=id,phone,company&phone=neq.null&limit=5000`, {
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  });
  if (!res.ok) throw new Error(`Get leads failed: ${res.status}`);
  const leads = await res.json();
  console.log(`📋 Loaded ${leads.length} leads with phone numbers`);
  // DEBUG: show sample phone formats
  leads.slice(0, 3).forEach(l => console.log(`  Lead sample: "${l.phone}" → "${normalizePhone(l.phone)}"`));
  return leads;
}

// ── 4. SYNCED CALL IDs ────────────────────────────────────────
async function getSyncedCallIds() {
  const syncUrl = `${SUPABASE_URL}/rest/v1/intermedia_call_log?select=call_id&limit=10000`;
  const res = await fetch(syncUrl, {
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  });
  if (!res.ok) return new Set();
  const rows = await res.json();
  return new Set(rows.map(r => r.call_id));
}

// ── 5. NORMALIZE PHONE ────────────────────────────────────────
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

// ── 6. SAVE CALL ──────────────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds || seconds < 1) return 'missed';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
}

async function saveCallLog(call, leadId, leadCompany) {
  // Build a stable call_id from whatever fields are available
  const callId = call.callId || call.id || call.callUid || call.uid ||
    `${call.startTime || call.timestamp || Date.now()}-${call.externalNumber || call.remoteNumber || 'unknown'}`;

  const duration  = call.duration || call.durationSeconds || call.talkDuration || 0;
  const direction = call.direction || call.callDirection ||
    (call.callType === 'outbound' || call.type === 'outbound' ? 'outbound' : 'inbound');
  const userName  = call.userName || call.agentName || call.userDisplayName ||
    call.extension?.name || call.user?.name || 'Unknown';
  const startTime = call.startTime || call.timestamp || call.startedAt || new Date().toISOString();

  // Insert into dedup table
  const logRes = await fetch(`${SUPABASE_URL}/rest/v1/intermedia_call_log`, {
    method:  'POST',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=ignore-duplicates,return=minimal'
    },
    body: JSON.stringify({
      call_id:   callId,
      lead_id:   leadId,
      direction,
      duration,
      user_name: userName,
      called_at: startTime,
      raw:       JSON.stringify(call)
    })
  });

  if (!logRes.ok && logRes.status !== 409) {
    console.error(`  ❌ Failed to save call log: ${logRes.status} ${await logRes.text()}`);
    return false;
  }
  if (logRes.status === 409 || logRes.status === 200) return false; // already synced

  // Get current lead state
  const stateRes = await fetch(
    `${SUPABASE_URL}/rest/v1/lead_states?lead_id=eq.${leadId}&select=timeline,call_count,last_call,cs`,
    { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const states   = await stateRes.json();
  const state    = states[0] || {};
  const timeline  = state.timeline   || [];
  const callCount = state.call_count || 0;

  const emoji      = direction === 'outbound' ? '📞' : '📲';
  const durationStr = formatDuration(duration);
  const timeStr    = new Date(startTime).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  timeline.push({
    ts:   startTime,
    v:    `${userName} (Intermedia)`,
    txt:  `${emoji} ${direction === 'outbound' ? 'Outbound' : 'Inbound'} call · ${durationStr} · ${timeStr}`,
    type: 'call_log'
  });

  // Upsert lead state
  await fetch(`${SUPABASE_URL}/rest/v1/lead_states?lead_id=eq.${leadId}`, {
    method:  'PATCH',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal'
    },
    body: JSON.stringify({
      timeline,
      call_count: callCount + 1,
      last_call:  startTime,
      cs:         state.cs === 'novo' ? 'contatado' : state.cs,
      updated_at: new Date().toISOString()
    })
  });

  // If no state existed yet, insert one
  if (!states.length) {
    await fetch(`${SUPABASE_URL}/rest/v1/lead_states`, {
      method:  'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=ignore-duplicates'
      },
      body: JSON.stringify({
        lead_id: leadId, timeline, call_count: 1,
        last_call: startTime, cs: 'contatado',
        updated_at: new Date().toISOString()
      })
    });
  }

  return true;
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('🌸 FloraForce Intermedia Sync started:', new Date().toISOString());
  try {
    const token  = await getAccessToken();
    const calls  = await getCallLogs(token);

    if (!calls.length) {
      console.log('ℹ️  No calls found in the last 2 hours. Nothing to sync.');
      return;
    }

    const leads  = await getLeads();
    const synced = await getSyncedCallIds();

    // Build phone → lead map
    const phoneMap = new Map();
    leads.forEach(l => {
      const norm = normalizePhone(l.phone);
      if (norm) phoneMap.set(norm, { id: l.id, company: l.company });
    });

    let matched = 0, skipped = 0, unmatched = 0;

    for (const call of calls) {
      const callId = call.id || call.callId || call.callUid || call.globalCallId;
      if (callId && synced.has(String(callId))) { skipped++; continue; }

      // Intermedia format: from.number and to.number
      // For outbound calls: to.number is the customer, from.number is the agent
      // For inbound calls: from.number is the customer, to.number is the agent
      const candidates = [
        call.direction === 'outbound' ? call.to?.number   : call.from?.number,
        call.direction === 'outbound' ? call.from?.number : call.to?.number,
        call.externalNumber, call.remoteNumber, call.calledNumber,
        call.callerNumber, call.toNumber, call.fromNumber,
        call.to?.number, call.from?.number
      ].filter(Boolean);

      // DEBUG: show what phone fields the call has
      if (matched + unmatched < 5) {
        console.log(`  🔍 Call phone candidates: ${candidates.join(' | ') || '(none found)'}`);
        console.log(`     All call keys: ${Object.keys(call).join(', ')}`);
      }

      let lead = null;
      for (const phone of candidates) {
        const norm = normalizePhone(phone);
        if (norm && phoneMap.has(norm)) {
          lead = phoneMap.get(norm);
          break;
        }
      }

      if (!lead) { unmatched++; continue; }

      const saved = await saveCallLog(call, lead.id, lead.company);
      if (saved) {
        matched++;
        console.log(`  ✅ Matched: ${candidates[0]} → ${lead.company}`);
      } else {
        skipped++;
      }
    }

    console.log(`\n🎉 Sync complete:`);
    console.log(`   ✅ Matched & saved: ${matched}`);
    console.log(`   ⏭  Already synced:  ${skipped}`);
    console.log(`   ❓ No lead match:   ${unmatched}`);

  } catch (err) {
    console.error('❌ Sync error:', err.message);
    process.exit(1);
  }
}

main();
