// FloraForce — Mailchimp Cold Lead Sync
// Calls the mailchimp-proxy edge function to import cold leads tagged in Mailchimp
const fetch = require('node-fetch');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET          = process.env.CRON_SECRET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !CRON_SECRET) {
  console.error('❌ Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, CRON_SECRET required');
  process.exit(1);
}

const PROXY_URL = SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/mailchimp-proxy';

async function main() {
  console.log('🌸 FloraForce Mailchimp Cold Lead Sync:', new Date().toISOString());
  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'x-cron-key':    CRON_SECRET,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
    },
    body: JSON.stringify({ action: 'import_cold_leads' }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    console.error('❌ Sync failed:', res.status, data);
    process.exit(1);
  }

  const imported = data.imported || [];
  console.log('✅ Imported:', imported.length, '| Skipped:', data.skipped || 0, '| Total checked:', data.total || 0);
  imported.forEach(l => console.log('  📥', l.email, '·', l.contact || l.company || ''));
}

main().catch(err => { console.error('❌ Sync error:', err.message); process.exit(1); });
