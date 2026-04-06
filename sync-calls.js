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

const INTERMEDIA_API_BASE = 'https://api.intermedia.net';

// ── 1. GET INTERMEDIA ACCESS TOKEN ────────────────────────────
async function getAccessToken() {
  const INTERMEDIA_AUTH_URL = 'https://login.intermedia.net/user/connect/token';

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     INTERMEDIA_CLIENT_ID,
    client_secret: INTERMEDIA_CLIENT_SECRET,
    scope:         'api.service.analytics.main'
  }).toString();

  console.log('🔑 Getting Intermedia token from:', INTERMEDIA_AUTH_URL);
  const res = await fetch(INTERMEDIA_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Auth failed: ${res.status} - ${err.substring(0,200)}`);
  }
  const data = await res.json();
  console.log('✅ Intermedia token obtained!');
  return data.access_token;
}

async function getCallLogs(token) {
  // POST to /analytics/calls/user with dateFrom/dateTo as query params
  const dateTo   = new Date();
  const dateFrom = new Date(dateTo.getTime() - 2 * 60 * 60 * 1000); // last 2 hours

  const formatDate = d => d.toISOString().replace('Z', '000Z'); // yyyy-MM-dd'T'HH:mm:ss.SSSZ

  const params = new URLSearchParams({
    dateFrom: formatDate(dateFrom),
    dateTo:   formatDate(dateTo)
  });

  const url = `https://api.intermedia.net/analytics/calls/user?${params}`;
  console.log(`📞 Fetching calls from: ${url}`);

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    },
    body: JSON.stringify({}) // empty body = all users
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Call logs failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  // Response could be array directly or wrapped in .calls / .items / .records
  const calls = Array.isArray(data) ? data : (data.calls || data.items || data.records || []);
  console.log(`📞 Retrieved ${calls.length} calls from Intermedia`);
  return calls;
}


