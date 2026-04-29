// FloraForce — Intermedia Call Sync
// Saves outbound calls only (matched and unmatched) for full vendor call counting
const fetch = require('node-fetch');

const INTERMEDIA_CLIENT_ID     = process.env.INTERMEDIA_CLIENT_ID     || '3jkwpsxZR04flEYCQUw';
const INTERMEDIA_CLIENT_SECRET = process.env.INTERMEDIA_CLIENT_SECRET || '1O72RhtUj31g6BuRFJ66STJqePdjovTECDUrU8jq3EU';
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

function defaultWeekRange() {
  // Week = Sunday 00:00 UTC → now
  const now       = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sun
  const dateFrom  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dayOfWeek));
  dateFrom.setUTCHours(0, 0, 0, 0);
  return { dateFrom, dateTo: now };
}

function chunkMonths(from, to) {
  const ranges = [];
  let cur = new Date(from);
  while (cur < to) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1, 0, 0, 0));
    const end  = next < to ? next : to;
    ranges.push({ dateFrom: new Date(cur), dateTo: new Date(end) });
    cur = next;
  }
  return ranges;
}

function extractCallsArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.calls))   return data.calls;
  if (Array.isArray(data.items))   return data.items;
  if (Array.isArray(data.records)) return data.records;
  if (Array.isArray(data.results)) return data.results;
  if (data.data && Array.isArray(data.data.calls))         return data.data.calls;
  if (data.data && Array.isArray(data.data))               return data.data;
  if (data.response && Array.isArray(data.response.calls)) return data.response.calls;
  return [];
}

async function getCallLogs(token, dateFrom, dateTo) {
  const params = new URLSearchParams({
    dateFrom: dateFrom.toISOString(),
    dateTo:   dateTo.toISOString()
  });

  const url = 'https://api.intermedia.net/analytics/usageHistory/calls?' + params.toString();
  console.log('📞 Fetching:', dateFrom.toISOString(), '→', dateTo.toISOString());

  const res = await fetch(url, {
    method:  'GET',
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
  });

  if (!res.ok) throw new Error('Call logs failed: ' + res.status + ' ' + await res.text());
  const data  = await res.json();
  const all   = extractCallsArray(data);
  const calls = all.filter(c => (c.direction || '').toLowerCase() === 'outbound');
  console.log('  ↳ retrieved', all.length, 'calls,', calls.length, 'outbound');
  return calls;
}

async function getLeads() {
  const url = SUPABASE_URL + '/rest/v1/leads?select=id,phone,phone2,company&limit=5000';
  const res = await fetch(url, { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY } });
  if (!res.ok) throw new Error('Get leads failed: ' + res.status);
  return await res.json();
}

async function getSyncedCallIds() {
  const ids = new Set();
  const pageSize = 10000;
  let offset = 0;
  while (true) {
    const url = SUPABASE_URL + '/rest/v1/intermedia_call_log?select=call_id&limit=' + pageSize + '&offset=' + offset;
    const res = await fetch(url, { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY } });
    if (!res.ok) break;
    const rows = await res.json();
    rows.forEach(r => ids.add(r.call_id));
    if (rows.length < pageSize) break;
    offset += pageSize;
    if (offset > 500000) break; // safety
  }
  return ids;
}

function normalizePhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  // Remove leading 1 (country code) if 11 digits
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  // Return last 10 digits
  digits = digits.slice(-10);
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
  const callId    = call.id || call.callId || call.uniqueId || call.globalCallId || call.globalId;
  const duration  = call.duration || call.durationSeconds || call.callDuration || 0;
  const direction = call.direction || call.callDirection || 'outbound';
  const userName  = extractUserName(call) || 'Unknown';
  const startTime = call.start || call.startTime || call.startedAt || call.callStart || call.callStartTime || new Date().toISOString();

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

async function processCalls(calls, phoneMap, synced) {
  let matched = 0, savedUnmatched = 0, skipped = 0;
  for (const call of calls) {
    const callId = call.id || call.callId || call.uniqueId || call.globalCallId || call.globalId;
    if (callId && synced.has(String(callId))) { skipped++; continue; }

    const customerPhone = call.direction === 'outbound'
      ? (call.to   && call.to.number)
      : (call.from && call.from.number);
    const norm = normalizePhone(customerPhone);
    const lead = norm ? phoneMap.get(norm) : null;

    const saved = await saveCallLog(call, lead ? lead.id : null);
    if (saved) {
      if (lead) matched++;
      else {
        savedUnmatched++;
        if (call.direction === 'outbound') {
          console.log('  📞 Saved (no lead):', extractUserName(call) || 'Unknown', '→', customerPhone);
        }
      }
      if (callId) synced.add(String(callId));
    } else {
      skipped++;
    }
  }
  return { matched, savedUnmatched, skipped };
}

async function main() {
  const fromEnv = process.env.SYNC_FROM ? new Date(process.env.SYNC_FROM + 'T00:00:00.000Z') : null;
  const toEnv   = process.env.SYNC_TO   ? new Date(process.env.SYNC_TO   + 'T23:59:59.999Z') : (fromEnv ? new Date() : null);
  const isBackfill = !!fromEnv;

  console.log('🌸 FloraForce Intermedia Sync started:', new Date().toISOString());
  if (isBackfill) console.log('🗓  Backfill mode:', fromEnv.toISOString(), '→', toEnv.toISOString());

  try {
    const token  = await getAccessToken();
    const leads  = await getLeads();
    const synced = await getSyncedCallIds();
    console.log('📦 Already in DB:', synced.size, 'calls · Leads:', leads.length);

    const phoneMap = new Map();
    leads.forEach(l => {
      const allPhones = [
        ...String(l.phone  || '').split(/[;,]/).map(p => p.trim()),
        ...String(l.phone2 || '').split(/[;,]/).map(p => p.trim()),
      ].filter(Boolean);
      allPhones.forEach(ph => {
        const n = normalizePhone(ph);
        if (n) phoneMap.set(n, { id: l.id, company: l.company });
      });
    });

    const ranges = isBackfill
      ? chunkMonths(fromEnv, toEnv)
      : [defaultWeekRange()];

    let totalMatched = 0, totalUnmatched = 0, totalSkipped = 0;
    for (const r of ranges) {
      const calls = await getCallLogs(token, r.dateFrom, r.dateTo);
      if (!calls.length) continue;
      const stats = await processCalls(calls, phoneMap, synced);
      totalMatched += stats.matched;
      totalUnmatched += stats.savedUnmatched;
      totalSkipped += stats.skipped;
    }

    console.log('🎉 Done — Matched:', totalMatched, '| Saved (no lead):', totalUnmatched, '| Skipped:', totalSkipped);
  } catch (err) {
    console.error('❌ Sync error:', err.message);
    process.exit(1);
  }
}

main();
