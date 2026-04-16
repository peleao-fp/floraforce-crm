// FloraForce — Intermedia Call Sync
// Saves ALL calls (matched and unmatched) for full vendor call counting
const fetch = require('node-fetch');

const INTERMEDIA_CLIENT_ID     = process.env.INTERMEDIA_CLIENT_ID;
const INTERMEDIA_CLIENT_SECRET = process.env.INTERMEDIA_CLIENT_SECRET;
const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY     = process.env.SUPABASE_SERVICE_KEY;

async function getAccessToken() {
  const url  = 'https://login.intermedia.net/user/connect/token';
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     INTERMEDIA_CLIENT_ID,
    client_secret: INTERMEDIA_CLIENT_SECRET,
    scope:         'api.service.analytics.main'
  }).toString();
  console.log('🔑 Getting token...');
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error('Auth failed: ' + res.status + ' ' + await res.text());
  const data = await res.json();
  console.log('✅ Token obtained!');
  return data.access_token;
}

async function getCallLogs(token) {
  const dateTo   = new Date();
  const dateFrom = new Date(dateTo.getTime() - 24 * 60 * 60 * 1000);
  const params   = new URLSearchParams({ dateFrom: dateFrom.toISOString(), dateTo: dateTo.toISOString() });
  const url      = 'https://api.intermedia.net/analytics/calls/user?' + params.toString();
  console.log('📞 Fetching calls:', dateFrom.toISOString(), '→', dateTo.toISOString());
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: '{}'
  });
  if (!res.ok) throw new Error('Call logs failed: ' + res.status + ' ' + await res.text());
  const data  = await res.json();
  const calls = data.calls || data.items || data.records || data.data || data.results || (Array.isArray(data) ? data : []);
  console.log('📞 Retrieved', calls.length, 'calls');
  return calls;
}

async function getLeads() {
  const url = SUPABASE_URL + '/rest/v1/leads?select=id,phone,company&phone=neq.null&limit=5000';
  const res = await fetch(url, { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY } });
  if (!res.ok) throw new Error('Get leads failed: ' + res.status);
  return await res.json();
}

async function getSyncedCallIds() {
  const url = SUPABASE_URL + '/rest/v1/intermedia_call_log?select=call_id&limit=10000';
  const res = await fetch(url, { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY } });
  if (!res.ok) return new Set();
  const rows = await res.json();
  return new Set(rows.map(r => r.call_id));
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function formatDuration(s) {
  if (!s || s < 1) return 'missed';
  const m = Math.floor(s / 60);
  return m === 0 ? s + 's' : m + 'm ' + (s % 60) + 's';
}

function extractUserName(call) {
  // For outbound: vendor is the caller (from)
  // For inbound: vendor is the receiver (to)
  if (call.direction === 'outbound') {
    return (call.from && call.from.name) || null;
  } else {
    return (call.to && call.to.name) || (call.from && call.from.name) || null;
  }
}

async function saveCallLog(call, leadId) {
  const callId    = call.id || call.callId || call.globalCallId;
  const duration  = call.duration || 0;
  const direction = call.direction || 'outbound';
  const userName  = extractUserName(call) || 'Unknown';
  const startTime = call.start || call.startTime || new Date().toISOString();

  // Save to intermedia_call_log (all calls, lead_id can be null)
  const logRes = await fetch(SUPABASE_URL + '/rest/v1/intermedia_call_log', {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=ignore-duplicates,return=minimal'
    },
    body: JSON.stringify({
      call_id:   callId,
      lead_id:   leadId || null,
      direction,
      duration,
      user_name: userName,
      called_at: startTime,
      raw:       JSON.stringify(call)
    })
  });

  // 200 = duplicate (already exists), skip lead state update
  if (logRes.status === 200) return false;
  if (!logRes.ok && logRes.status !== 409 && logRes.status !== 201) {
    console.error('  ❌ Log insert failed:', logRes.status);
    return false;
  }

  // Only update lead state if we have a matched lead
  if (leadId) {
    const stateRes = await fetch(SUPABASE_URL + '/rest/v1/lead_states?lead_id=eq.' + leadId + '&select=timeline,call_count,cs', {
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY }
    });
    const states   = await stateRes.json();
    const state    = states[0] || {};
    const timeline = state.timeline || [];
    const emoji    = direction === 'outbound' ? '📞' : '📲';
    timeline.push({
      ts:   startTime,
      v:    userName + ' (Intermedia)',
      txt:  emoji + ' ' + (direction === 'outbound' ? 'Outbound' : 'Inbound') + ' call · ' + formatDuration(duration),
      type: 'call_log'
    });

    if (states.length > 0) {
      await fetch(SUPABASE_URL + '/rest/v1/lead_states?lead_id=eq.' + leadId, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          timeline,
          call_count: (state.call_count || 0) + 1,
          last_call:  startTime,
          updated_at: new Date().toISOString()
        })
      });
    } else {
      await fetch(SUPABASE_URL + '/rest/v1/lead_states', {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=ignore-duplicates'
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
  }

  return true;
}

async function main() {
  console.log('🌸 FloraForce Intermedia Sync started:', new Date().toISOString());
  try {
    const token  = await getAccessToken();
    const calls  = await getCallLogs(token);
    if (!calls.length) { console.log('ℹ️  No calls in last 24 hours.'); return; }

    const leads  = await getLeads();
    const synced = await getSyncedCallIds();

    // Build phone → lead map
    const phoneMap = new Map();
    leads.forEach(l => {
      const n = normalizePhone(l.phone);
      if (n) phoneMap.set(n, { id: l.id, company: l.company });
    });

    let matched = 0, savedUnmatched = 0, skipped = 0;

    for (const call of calls) {
      const callId = call.id || call.callId || call.globalCallId;

      // Skip already synced
      if (callId && synced.has(String(callId))) { skipped++; continue; }

      // Try to match lead by phone
      const customerPhone = call.direction === 'outbound'
        ? (call.to   && call.to.number)
        : (call.from && call.from.number);

      const norm = normalizePhone(customerPhone);
      const lead = norm ? phoneMap.get(norm) : null;

      // Save ALL calls — with or without lead match
      const saved = await saveCallLog(call, lead ? lead.id : null);

      if (saved) {
        if (lead) {
          matched++;
        } else {
          savedUnmatched++;
          const userName = extractUserName(call) || 'Unknown';
          // Only log unmatched for outbound to reduce noise
          if (call.direction === 'outbound') {
            console.log('  📞 Saved (no lead):', userName, '→', customerPhone);
          }
        }
      } else {
        skipped++;
      }
    }

    console.log('🎉 Done — Matched leads:', matched, '| Saved (no lead):', savedUnmatched, '| Skipped:', skipped);
  } catch (err) {
    console.error('❌ Sync error:', err.message);
    process.exit(1);
  }
}

main();
