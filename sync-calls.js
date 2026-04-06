// ============================================================
// FloraForce — Intermedia Call Sync
// Pulls call logs from Intermedia API every hour,
// matches them to leads by phone number,
// and logs them in the lead timeline in Supabase.
// ============================================================

const fetch = require('node-fetch');

const INTERMEDIA_CLIENT_ID     = process.env.INTERMEDIA_CLIENT_ID;
const INTERMEDIA_CLIENT_SECRET = process.env.INTERMEDIA_CLIENT_SECRET;
const INTERMEDIA_ACCOUNT_ID    = process.env.INTERMEDIA_ACCOUNT_ID;
const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY     = process.env.SUPABASE_SERVICE_KEY;

const INTERMEDIA_AUTH_URL = 'https://auth.intermedia.net/oauth2/token';
const INTERMEDIA_API_BASE = 'https://api.intermedia.net';

// ── 1. GET INTERMEDIA ACCESS TOKEN ────────────────────────────
async function getAccessToken() {
  const creds = Buffer.from(`${INTERMEDIA_CLIENT_ID}:${INTERMEDIA_CLIENT_SECRET}`).toString('base64');

  // Try multiple possible auth URLs
  const authUrls = [
    'https://auth.intermedia.net/oauth2/token',
    'https://auth-cpaas.intermedia.net/oauth2/token',
    'https://api.intermedia.net/oauth2/token',
  ];

  for (const url of authUrls) {
    try {
      console.log(`Trying auth URL: ${url}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials&scope=analytics.read'
      });
      if (res.ok) {
        const data = await res.json();
        console.log(`✅ Intermedia token obtained from: ${url}`);
        return data.access_token;
      }
      const err = await res.text();
      console.log(`Auth failed at ${url}: ${res.status} - ${err.substring(0,100)}`);
    } catch (e) {
      console.log(`DNS/network error at ${url}: ${e.message}`);
    }
  }
  throw new Error('All Intermedia auth URLs failed');
}

// ── 2. GET CALL LOGS FROM INTERMEDIA ─────────────────────────
async function getCallLogs(token) {
  // Get calls from the last 2 hours (with overlap to avoid missing any)
  const dateTo   = new Date();
  const dateFrom = new Date(dateTo.getTime() - 2 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    dateFrom: dateFrom.toISOString(),
    dateTo:   dateTo.toISOString(),
    limit:    '500'
  });

  const res = await fetch(
    `${INTERMEDIA_API_BASE}/v1/accounts/${INTERMEDIA_ACCOUNT_ID}/analytics/calls?${params}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Call logs failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  const calls = data.calls || data.items || data || [];
  console.log(`📞 Retrieved ${calls.length} calls from Intermedia`);
  return calls;
}

// ── 3. GET ALL LEADS FROM SUPABASE ────────────────────────────
async function getLeads() {
  // Get all leads with phone numbers
  const res = await fetch(`${SUPABASE_URL}/rest/v1/leads?select=id,phone,company&phone=neq.null`, {
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  });
  if (!res.ok) throw new Error(`Get leads failed: ${res.status}`);
  const leads = await res.json();
  console.log(`📋 Loaded ${leads.length} leads with phone numbers`);
  return leads;
}

// ── 4. GET ALREADY SYNCED CALL IDs ────────────────────────────
async function getSyncedCallIds() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/intermedia_call_log?select=call_id`,
    {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    }
  );
  if (!res.ok) return new Set();
  const rows = await res.json();
  return new Set(rows.map(r => r.call_id));
}

// ── 5. NORMALIZE PHONE NUMBER ─────────────────────────────────
function normalizePhone(phone) {
  if (!phone) return null;
  // Strip everything except digits
  const digits = String(phone).replace(/\D/g, '');
  // Handle US numbers — last 10 digits
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

// ── 6. MATCH CALL TO LEAD ─────────────────────────────────────
function matchCallToLead(call, leadsPhoneMap) {
  // Try the external number (customer's number)
  const externalNumber = call.externalNumber || call.remoteNumber || call.calledNumber || call.callerNumber;
  const normalized = normalizePhone(externalNumber);
  if (!normalized) return null;
  return leadsPhoneMap.get(normalized) || null;
}

// ── 7. FORMAT DURATION ────────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds || seconds < 1) return 'missed';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

// ── 8. SAVE CALL TO SUPABASE ──────────────────────────────────
async function saveCallLog(call, leadId, leadCompany) {
  const callId   = call.callId || call.id || `${call.startTime}-${call.externalNumber}`;
  const duration = call.duration || call.durationSeconds || 0;
  const direction = call.direction || (call.callType === 'outbound' ? 'outbound' : 'inbound');
  const userName  = call.userName || call.agentName || call.extension?.name || 'Unknown';
  const startTime = call.startTime || call.timestamp || new Date().toISOString();

  // 1. Insert into intermedia_call_log table (dedup table)
  const logRes = await fetch(`${SUPABASE_URL}/rest/v1/intermedia_call_log`, {
    method: 'POST',
    headers: {
      'apikey':          SUPABASE_SERVICE_KEY,
      'Authorization':   `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':    'application/json',
      'Prefer':          'resolution=ignore-duplicates,return=minimal'
    },
    body: JSON.stringify({
      call_id:    callId,
      lead_id:    leadId,
      direction,
      duration:   duration,
      user_name:  userName,
      called_at:  startTime,
      raw:        JSON.stringify(call)
    })
  });

  if (!logRes.ok && logRes.status !== 409) {
    console.error(`Failed to save call log: ${logRes.status}`);
    return false;
  }
  if (logRes.status === 409) return false; // Already synced

  // 2. Get current lead_state to append to timeline
  const stateRes = await fetch(
    `${SUPABASE_URL}/rest/v1/lead_states?lead_id=eq.${leadId}&select=timeline,call_count,last_call`,
    {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    }
  );
  const states = await stateRes.json();
  const state  = states[0] || {};
  const timeline  = state.timeline  || [];
  const callCount = state.call_count || 0;

  // 3. Add call to timeline
  const emoji = direction === 'outbound' ? '📞' : '📲';
  const durationStr = formatDuration(duration);
  const timeStr = new Date(startTime).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  timeline.push({
    ts:  startTime,
    v:   `${userName} (Intermedia)`,
    txt: `${emoji} ${direction === 'outbound' ? 'Outbound' : 'Inbound'} call · ${durationStr} · ${timeStr}`,
    type: 'call_log'
  });

  // 4. Update lead_state
  const updateRes = await fetch(
    `${SUPABASE_URL}/rest/v1/lead_states?lead_id=eq.${leadId}`,
    {
      method: 'PATCH',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal'
      },
      body: JSON.stringify({
        timeline:   timeline,
        call_count: callCount + 1,
        last_call:  startTime,
        cs:         'contatado', // auto-update status if it was 'novo'
        updated_at: new Date().toISOString()
      })
    }
  );

  // If no lead_state exists yet, insert one
  if (!updateRes.ok || (await fetch(`${SUPABASE_URL}/rest/v1/lead_states?lead_id=eq.${leadId}`, { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }).then(r => r.json()).then(d => d.length === 0))) {
    await fetch(`${SUPABASE_URL}/rest/v1/lead_states`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=ignore-duplicates'
      },
      body: JSON.stringify({
        lead_id:    leadId,
        timeline,
        call_count: 1,
        last_call:  startTime,
        cs:         'contatado',
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
    // Get auth token
    const token = await getAccessToken();

    // Get calls from last 2 hours
    const calls = await getCallLogs(token);
    if (!calls.length) {
      console.log('No calls to sync.');
      return;
    }

    // Get leads with phone numbers
    const leads = await getLeads();

    // Build phone → lead map for fast lookup
    const phoneMap = new Map();
    leads.forEach(l => {
      const norm = normalizePhone(l.phone);
      if (norm) phoneMap.set(norm, { id: l.id, company: l.company });
    });

    // Get already synced call IDs
    const synced = await getSyncedCallIds();

    // Process each call
    let matched = 0, skipped = 0, unmatched = 0;
    for (const call of calls) {
      const callId = call.callId || call.id;

      // Skip already synced
      if (callId && synced.has(callId)) { skipped++; continue; }

      // Try to match to a lead
      const lead = matchCallToLead(call, phoneMap);
      if (!lead) { unmatched++; continue; }

      // Save to Supabase
      const saved = await saveCallLog(call, lead.id, lead.company);
      if (saved) {
        matched++;
        console.log(`  ✅ Matched: ${call.externalNumber || call.remoteNumber} → ${lead.company}`);
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
