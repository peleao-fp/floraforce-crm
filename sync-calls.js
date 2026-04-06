// FloraForce — Intermedia Call Sync
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
  calls.slice(0, 3).forEach((c, i) => console.log('  Call', i+1, ':', JSON.stringify(c).substring(0, 250)));
  return calls;
}

async function getLeads() {
  const url = SUPABASE_URL + '/rest/v1/leads?select=id,phone,company&phone=neq.null&limit=5000';
  const res = await fetch(url, { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY } });
  if (!res.ok) throw new Error('Get leads failed: ' + res.status);
  const leads = await res.json();
  console.log('📋 Loaded', leads.length, 'leads with phone numbers');
  leads.slice(0, 3).forEach(l => console.log('  Sample: "' + l.phone + '" →', normalizePhone(l.phone)));
  return leads;
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

async function saveCallLog(call, leadId) {
  const callId    = call.id || call.callId || call.globalCallId;
  const duration  = call.duration || 0;
  const direction = call.direction || 'outbound';
  const userName  = (direction === 'outbound' ? (call.from && call.from.name) : (call.to && call.to.name)) || 'Unknown';
  const startTime = call.start || call.startTime || new Date().toISOString();

  const logRes = await fetch(SUPABASE_URL + '/rest/v1/intermedia_call_log', {
    method: 'POST',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ call_id: callId, lead_id: leadId, direction, duration, user_name: userName, called_at: startTime, raw: JSON.stringify(call) })
  });
  if (logRes.status === 200) return false;
  if (!logRes.ok && logRes.status !== 409) { console.error('  ❌ Log insert failed:', logRes.status); return false; }

  const stateRes = await fetch(SUPABASE_URL + '/rest/v1/lead_states?lead_id=eq.' + leadId + '&select=timeline,call_count,cs', {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY }
  });
  const states   = await stateRes.json();
  const state    = states[0] || {};
  const timeline = state.timeline || [];
  const emoji    = direction === 'outbound' ? '📞' : '📲';
  timeline.push({ ts: startTime, v: userName + ' (Intermedia)', txt: emoji + ' ' + (direction === 'outbound' ? 'Outbound' : 'Inbound') + ' call · ' + formatDuration(duration), type: 'call_log' });

  if (states.length > 0) {
    await fetch(SUPABASE_URL + '/rest/v1/lead_states?lead_id=eq.' + leadId, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ timeline, call_count: (state.call_count || 0) + 1, last_call: startTime, updated_at: new Date().toISOString() })
    });
  } else {
    await fetch(SUPABASE_URL + '/rest/v1/lead_states', {
      method: 'POST',
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates' },
      body: JSON.stringify({ lead_id: leadId, timeline, call_count: 1, last_call: startTime, cs: 'contatado', updated_at: new Date().toISOString() })
    });
  }
  return true;
}

async function main() {
  console.log('🌸 FloraForce Intermedia Sync started:', new Date().toISOString());
  try {
    const token  = await getAccessToken();
    const calls  = await getCallLogs(token);
    if (!calls.length) { console.log('ℹ️  No calls in last 2 hours.'); return; }

    const leads  = await getLeads();
    const synced = await getSyncedCallIds();

    const phoneMap = new Map();
    leads.forEach(l => { const n = normalizePhone(l.phone); if (n) phoneMap.set(n, { id: l.id, company: l.company }); });

    let matched = 0, skipped = 0, unmatched = 0;
    for (const call of calls) {
      const callId = call.id || call.callId || call.globalCallId;
      if (callId && synced.has(String(callId))) { skipped++; continue; }

      const customerPhone = call.direction === 'outbound'
        ? (call.to && call.to.number)
        : (call.from && call.from.number);

      console.log('  🔍', call.direction, '| customer:', customerPhone, '| norm:', normalizePhone(customerPhone));

      const norm = normalizePhone(customerPhone);
      const lead = norm ? phoneMap.get(norm) : null;

      if (!lead) { unmatched++; continue; }
      const saved = await saveCallLog(call, lead.id);
      if (saved) { matched++; console.log('  ✅ Saved:', customerPhone, '→', lead.company); }
      else skipped++;
    }
    console.log('🎉 Done — Matched:', matched, '| Skipped:', skipped, '| Unmatched:', unmatched);
  } catch (err) {
    console.error('❌ Sync error:', err.message);
    process.exit(1);
  }
}

main();
