// ── CONFIG ────────────────────────────────────────────────────
const SUPA_URL = 'https://zsgoocrqhzndghpseqtj.supabase.co';
const SUPA_KEY = 'sb_publishable_bSn29xCCTZYvTsE7uXptZg_17eYrqr5';

let sb = null;
let currentUser = null, currentProfile = null;
let leads = [], filteredLeads = [];
let currentPage = 1;
const PER_PAGE = 50;
let currentLead = null, sessionCalls = 0;
let activeStatus = 'all', activeSpecials = new Set(), sortMode = 'default';
let idleTimer = null, lastActivity = Date.now();
const IDLE_MINUTES = 15;

// ── THEME ─────────────────────────────────────────────────────
function loadTheme() {
  const saved = localStorage.getItem('crm-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = saved === 'light' ? '🌙' : '☀️';
  updateLogoForTheme(saved);
}
function updateLogoForTheme(theme) {
  const base = 'https://peleao-fp.github.io/floraforce-crm/assets/';
  const src = theme === 'light' ? base + 'LOGO-FF-ESCURO.png' : base + 'LOGO-FF-CLARO.png';
  ['topbar-logo','login-logo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.src = src;
  });
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('crm-theme', next);
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = next === 'light' ? '🌙' : '☀️';
  updateLogoForTheme(next);
}

// ── LOADER ────────────────────────────────────────────────────
function setLoader(msg, pct) {
  const msgEl  = document.getElementById('loader-msg');
  const fillEl = document.getElementById('loader-fill');
  if (msgEl)  msgEl.textContent = msg;
  if (fillEl && pct) fillEl.style.width = pct + '%';
}
function hideLoader() {
  const el = document.getElementById('loading-screen');
  if (el) el.style.display = 'none';
}
function showLogin() {
  const el = document.getElementById('login-screen');
  if (el) el.style.display = 'flex';
}

// ── BOOT ──────────────────────────────────────────────────────
async function boot() {
  loadTheme();
  initSB();
  setLoader('Verifying session...', 20);
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { hideLoader(); showLogin(); return; }
    await loadApp(session.user);
  } catch(e) {
    setLoader('Connection error — please refresh.', 0);
    console.error('Boot error:', e);
  }
}

function initSB() {
  sb = window.supabase.createClient(SUPA_URL, SUPA_KEY);
}

async function loadApp(user) {
  currentUser = user;
  setLoader('Loading profile...', 30);
  const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).single();
  currentProfile = profile;

  setLoader('Loading leads...', 50);
  await loadLeads();

  setLoader('Loading activity...', 75);
  await loadLeadStates(); // loads intermedia call counts into window._callsByProfile
  await loadMktTagTypes();
  await loadCallCount();  // must run AFTER loadLeadStates so _callsByProfile is ready

  // Pre-load users so Owner dropdown works in modal without opening Admin panel
  const { data: usersData } = await sb.from('profiles').select('*').order('name');
  allUsers = usersData || [];

  // Load segmentations
  await loadSegmentations();

  setLoader('Ready!', 100);
  setTimeout(() => {
    hideLoader();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').classList.add('app-visible');
    if (currentProfile?.role === 'admin') {
      document.getElementById('btn-admin').style.display = '';
      document.getElementById('tab-btn-analytics').style.display = '';
      document.getElementById('tab-btn-sales').style.display = '';
    } else {
      if (hasPermission('view_analytics')) document.getElementById('tab-btn-analytics').style.display = '';
      if (hasPermission('view_analytics')) document.getElementById('tab-btn-sales').style.display = '';
    }
    if (currentProfile?.role === 'admin' || hasPermission('view_mkt')) {
      document.getElementById('btn-mkt').style.display = '';
    }
    // Hide export CSV button if no permission
    const csvBtn = document.querySelector('[onclick="exportCSV()"]');
    if (csvBtn && !hasPermission('export_csv')) csvBtn.style.display = 'none';
    // Hide bulk import nav (admin panel only anyway)
    // Hide new lead button if no permission
    const newLeadBtn = document.querySelector('[onclick="openNewLeadModal()"]');
    if (newLeadBtn && !hasPermission('create_leads')) newLeadBtn.style.display = 'none';
    document.getElementById('user-name').textContent = currentProfile?.name || user.email;
    document.getElementById('user-role').textContent  = currentProfile?.role === 'admin' ? 'Admin' : 'Vendor';
    populateFilters();
    applyFilters();
    renderDashboard();
    startIdleTracking();
    logActivity(null, null, 'login', 'Logged in');
  }, 300);
}

// ── IDLE TRACKING ─────────────────────────────────────────────
function startIdleTracking() {
  const reset = () => {
    if (Date.now() - lastActivity > IDLE_MINUTES * 60 * 1000) {
      logActivity(null, null, 'idle_return', 'Returned from inactivity');
    }
    lastActivity = Date.now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logActivity(null, null, 'idle', 'Inactive for ' + IDLE_MINUTES + 'min');
    }, IDLE_MINUTES * 60 * 1000);
  };
  ['click','keydown','mousemove','scroll'].forEach(e => document.addEventListener(e, reset, { passive: true }));
  reset();
}

// ── LOAD LEADS ────────────────────────────────────────────────
async function loadLeads() {
  let all = [];
  let from = 0;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data, error } = await sb.from('leads').select('*').range(from, from + PAGE_SIZE - 1);
    if (error || !data || !data.length) break;
    all = all.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
    setLoader('Loading leads... ' + all.length, 55);
  }
  leads = all.map(l => ({
    id:          l.id,
    c:           l.company     || '',
    p:           l.pipeline    || '',
    r:           l.responsible || '',
    st:          l.state       || '',
    ty:          l.type        || '',
    cn:          l.contact     || '',
    em:          l.email       || '',
    ph:          l.phone       || '',
    sl: l.sales_total ? {
      total:     parseFloat(l.sales_total)  || 0,
      count:     parseInt(l.sales_count)    || 0,
      rep:       l.sales_rep   || '',
      last_date: l.sales_last  || ''
    } : null,
    // state (overwritten by lead_states)
    cs: 'novo', tg: [], pr: false, cc: 0,
    lc: null, cv: false, cm: '', tl: [],
    responsible: l.responsible || '',
    mkt_tag: ''
  }));
}

// ── LEAD STATES ───────────────────────────────────────────────
async function loadLeadStates() {
  const { data } = await sb.from('lead_states').select('*');
  if (!data) return;
  const map = {};
  data.forEach(s => { map[s.lead_id] = s; });
  leads.forEach(l => {
    const s = map[l.id];
    if (!s) return;
    l.cs          = s.cs         || 'novo';
    l.tg          = s.tags       || [];
    l.pr          = s.priority   || false;
    l.cc          = s.call_count || 0;
    l.lc          = s.last_call  || null;
    l.cv          = s.converted  || false;
    l.cm          = s.notes      || '';
    l.tl          = s.timeline   || [];
    l.responsible = s.responsible || l.r;
    l.mkt_tag     = s.mkt_tag    || '';
  });
  // Overlay real call counts from Intermedia
  await loadIntermedaCallCounts();
}

async function loadIntermedaCallCounts() {
  // Get start of current week (Monday) in UTC to match Supabase
  const now = new Date();
  const day = now.getUTCDay() || 7; // 1=Mon ... 7=Sun
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (day - 1)));

  // Load ALL calls (for lead counts)
  const { data: allData } = await sb.from('intermedia_call_log')
    .select('lead_id, called_at, user_name, direction, duration')
    .not('lead_id', 'is', null);

  // Load THIS WEEK calls (for progress bar)
  const { data: weekData } = await sb.from('intermedia_call_log')
    .select('user_name')
    .gte('called_at', weekStart.toISOString());

  if (!allData) return;

  const counts = {}, lastCall = {}, callsByIntermediaName = {}, weeklyByIntermediaName = {};

  allData.forEach(c => {
    if (!c.lead_id) return;
    counts[c.lead_id] = (counts[c.lead_id] || 0) + 1;
    if (!lastCall[c.lead_id] || c.called_at > lastCall[c.lead_id]) {
      lastCall[c.lead_id] = c.called_at;
    }
    if (c.user_name) {
      callsByIntermediaName[c.user_name] = (callsByIntermediaName[c.user_name] || 0) + 1;
    }
  });

  // Build weekly counts from separate query
  (weekData || []).forEach(c => {
    if (c.user_name) {
      weeklyByIntermediaName[c.user_name] = (weeklyByIntermediaName[c.user_name] || 0) + 1;
    }
  });

  window._callsByIntermediaName = callsByIntermediaName;
  window._weeklyByIntermediaName = weeklyByIntermediaName;

  await buildCallsByProfile(callsByIntermediaName, weeklyByIntermediaName);

  leads.forEach(l => {
    if (counts[l.id]) {
      l.cc = counts[l.id];
      const iLc = lastCall[l.id];
      if (iLc && (!l.lc || iLc > l.lc)) l.lc = iLc;
    }
  });
}

async function buildCallsByProfile(callsByIntermediaName, weeklyByIntermediaName = {}) {
  let users = allUsers;
  if (!users || users.length === 0) {
    const { data } = await sb.from('profiles').select('name, role');
    users = data || [];
  }
  window._callsByProfile = {};
  window._weeklyCallsByProfile = {};
  users.forEach(u => {
    const pName = u.name.toLowerCase();
    let total = 0, weekly = 0;
    Object.entries(callsByIntermediaName).forEach(([iName, cnt]) => {
      const iLower = iName.toLowerCase();
      const words = iLower.split(' ').filter(w => w.length > 2);
      const match = pName === iLower || pName.includes(iLower) || iLower.includes(pName) ||
        words.every(w => pName.includes(w));
      if (match) {
        total += cnt;
        weekly += weeklyByIntermediaName[iName] || 0;
      }
    });
    if (total > 0) window._callsByProfile[u.name] = total;
    window._weeklyCallsByProfile[u.name] = weekly;
  });
}

async function saveLeadState(lead) {
  setSyncStatus('syncing');
  const { error } = await sb.from('lead_states').upsert({
    lead_id:     lead.id,
    responsible: lead.responsible || lead.r,
    cs:          lead.cs,
    tags:        lead.tg          || [],
    priority:    lead.pr          || false,
    call_count:  lead.cc          || 0,
    last_call:   lead.lc          || null,
    converted:   lead.cv          || false,
    notes:       lead.cm          || '',
    timeline:    lead.tl          || [],
    mkt_tag:     lead.mkt_tag     || null,
    updated_by:  currentUser?.id,
    updated_at:  new Date().toISOString()
  }, { onConflict: 'lead_id' });
  setSyncStatus(error ? 'error' : 'ok');
  // Sync to Mailchimp in background (silent, no await)
  if (lead.em) syncToMailchimp(lead);
}

// Silent background sync — never blocks the UI
async function syncToMailchimp(lead) {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    await fetch(MC_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify({
        action: 'sync_contact',
        lead: {
          email:       lead.em,
          contact:     lead.cn || '',
          company:     lead.c  || '',
          segmentation: lead.p || '',
          crm_status:  lead.cs || '',
          mkt_tag:     lead.mkt_tag || '',
        }
      })
    });
  } catch(e) {
    // Silent fail — don't disrupt the user
    console.warn('MC sync failed:', e.message);
  }
}

// ── CALL COUNT ────────────────────────────────────────────────
function getWeek() {
  const d = new Date(), day = d.getDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return d.getUTCFullYear() + '-W' + Math.ceil((((d - ys) / 86400000) + 1) / 7);
}

async function loadCallCount() {
  if (!currentUser || !currentProfile) return;
  // Use weekly counts built during loadIntermedaCallCounts
  sessionCalls = (window._weeklyCallsByProfile || {})[currentProfile.name] || 0;
  updateProgress();
}

async function saveCallCount() {
  if (!currentUser) return;
  await sb.from('call_counts').upsert({
    user_id:     currentUser.id,
    vendor_name: currentProfile?.name || '',
    week_key:    getWeek(),
    calls:       sessionCalls,
    updated_at:  new Date().toISOString()
  }, { onConflict: 'user_id,week_key' });
}

// ── ACTIVITY LOG ──────────────────────────────────────────────
async function logActivity(leadId, leadName, action, detail) {
  await sb.from('activity_log').insert({
    user_id:   currentUser?.id,
    user_name: currentProfile?.name || '?',
    lead_id:   leadId,
    lead_name: leadName,
    action,
    detail
  });
}

// ── SYNC STATUS ───────────────────────────────────────────────
function setSyncStatus(s) {
  const dot = document.getElementById('sync-dot');
  const lbl = document.getElementById('sync-lbl');
  if (!dot) return;
  if (s === 'syncing') { dot.className = 'sync-dot syncing'; lbl.textContent = 'Saving...'; }
  else if (s === 'ok') { dot.className = 'sync-dot';         lbl.textContent = 'Synced'; }
  else                 { dot.className = 'sync-dot error';   lbl.textContent = 'Error'; }
}

// ── AUTH ──────────────────────────────────────────────────────
async function doForgotPassword(e) {
  e.preventDefault();
  const email = document.getElementById('l-email').value.trim();
  if (!email) { 
    document.getElementById('l-err').textContent = 'Enter your email first.';
    return; 
  }
  document.getElementById('l-btn').disabled = true;
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: 'https://peleao-fp.github.io/floraforce-crm/'
  });
  document.getElementById('l-btn').disabled = false;
  if (error) {
    document.getElementById('l-err').textContent = error.message;
  } else {
    document.getElementById('l-err').textContent = '';
    document.getElementById('l-reset-msg').style.display = 'block';
  }
}

async function doLogin() {
  const email = document.getElementById('l-email').value.trim();
  const pass  = document.getElementById('l-pass').value;
  const btn   = document.getElementById('l-btn');
  const err   = document.getElementById('l-err');
  err.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Signing in...';
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
  if (error) {
    err.textContent = 'Incorrect email or password.';
    err.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Sign In';
    return;
  }
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('loading-screen').style.display = 'flex';
  await loadApp(data.user);
}
async function doLogout() {
  logActivity(null, null, 'logout', 'Logged out');
  await sb.auth.signOut();
  location.reload();
}

// ── HELPERS ───────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}
function lastContactBadge(lead) {
  const days = daysSince(lead.lc);
  if (days === null) return '<span style="color:var(--text3);font-size:10px">Never</span>';
  if (days === 0)    return '<span style="color:var(--accent);font-size:10px">Today</span>';
  if (days <= 3)     return '<span style="color:var(--accent);font-size:10px">' + days + 'd</span>';
  if (days <= 7)     return '<span style="color:var(--warn);font-size:10px">' + days + 'd</span>';
  return '<span style="color:var(--danger);font-size:10px">⚠️' + days + 'd</span>';
}
function statusBadge(cs) {
  const map = {
    novo:      '<span class="badge badge-novo">New</span>',
    contatado: '<span class="badge badge-contatado">Contacted</span>',
    proposta:  '<span class="badge badge-proposta">Proposal</span>',
    cliente:   '<span class="badge badge-cliente">Customer ✓</span>'
  };
  return map[cs] || '<span class="badge">—</span>';
}

// ── FILTERS ───────────────────────────────────────────────────
function getMyLeads() {
  if (!currentProfile) return leads;
  if (currentProfile.role === 'admin' || hasPermission('view_all_leads')) return leads;
  return leads.filter(l => (l.responsible || l.r) === currentProfile.name);
}
function populateFilters() {
  const pool   = getMyLeads();
  const states = [...new Set(pool.map(l => l.st).filter(Boolean))].sort();
  const sSel   = document.getElementById('filter-state');
  states.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; sSel.appendChild(o); });
  // Use segmentations list for filter
  populateSegmentationFilter();
}
function toggleStatus(el, val) {
  document.querySelectorAll('#status-chips .chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  activeStatus = val;
  currentPage = 1;
  applyFilters();
}
function toggleSpecial(el, val) {
  el.classList.toggle('active');
  activeSpecials.has(val) ? activeSpecials.delete(val) : activeSpecials.add(val);
  currentPage = 1;
  applyFilters();
}
function applyFilters() {
  const search   = document.getElementById('search-input')?.value.toLowerCase() || '';
  const pipeline = document.getElementById('filter-segmentation')?.value || '';
  const type     = document.getElementById('filter-type')?.value || '';
  const state    = document.getElementById('filter-state')?.value || '';
  const pool     = getMyLeads();
  filteredLeads  = pool.filter(l => {
    if (activeStatus !== 'all' && l.cs !== activeStatus) return false;
    if (pipeline && l.p !== pipeline)                     return false;
    if (type     && !(l.ty || '').includes(type))         return false;
    if (state    && l.st !== state)                        return false;
    if (activeSpecials.has('priority')   && !l.pr)         return false;
    if (activeSpecials.has('has_sales')  && !l.sl)         return false;
    if (activeSpecials.has('has_phone')  && !l.ph)         return false;
    if (activeSpecials.has('no_contact') && l.lc)          return false;
    if (search) {
      const h = (l.c + ' ' + l.cn + ' ' + l.em).toLowerCase();
      if (!h.includes(search)) return false;
    }
    return true;
  });
  if      (sortMode === 'priority') filteredLeads.sort((a,b) => (b.pr?1:0) - (a.pr?1:0));
  else if (sortMode === 'calls')    filteredLeads.sort((a,b) => b.cc - a.cc);
  else if (sortMode === 'company')  filteredLeads.sort((a,b) => a.c.localeCompare(b.c));
  else if (sortMode === 'sales')    filteredLeads.sort((a,b) => (b.sl?b.sl.total:0) - (a.sl?a.sl.total:0));
  else if (sortMode === 'idle')     filteredLeads.sort((a,b) => (daysSince(b.lc)||9999) - (daysSince(a.lc)||9999));
  else                              filteredLeads.sort((a,b) => (b.pr?1:0) - (a.pr?1:0));
  currentPage = 1;
  renderTable();
  renderPagination();
  updateMiniStats();
  updateTopbarStats();
}
function sortBy(m) { sortMode = m; applyFilters(); }

// ── TABLE ─────────────────────────────────────────────────────
function renderTable() {
  const start = (currentPage - 1) * PER_PAGE;
  const page  = filteredLeads.slice(start, start + PER_PAGE);
  document.getElementById('lc-shown').textContent = filteredLeads.length.toLocaleString();
  document.getElementById('lc-total').textContent = getMyLeads().length.toLocaleString();
  const tbody = document.getElementById('leads-tbody');
  if (!filteredLeads.length) {
    tbody.innerHTML = '<tr><td colspan="10"><div class="empty-state"><h3>No leads found</h3></div></td></tr>';
    return;
  }
  tbody.innerHTML = page.map(l => {
    const tags    = (l.tg || []).slice(0,2).map(t => '<span class="tag-pill">' + esc(t) + '</span>').join('');
    const sales   = ''; // Sales data removed (CSV import not current)
    const st      = l.st ? (l.st.split(' - ')[1] || l.st) : '—';
    const callBtn = l.ph
      ? '<a href="tel:' + l.ph.replace(/\D/g,'') + '" class="btn btn-ghost" style="padding:4px 8px;font-size:11px;text-decoration:none" title="' + esc(l.ph) + '">📞</a>'
      : '<button class="btn btn-ghost" style="padding:4px 8px;font-size:11px;opacity:.3" disabled>📞</button>';
    return '<tr class="' + (l.pr ? 'priority-row' : '') + '" onclick="openModal(' + l.id + ')">'
      + '<td>' + (l.pr ? '<span class="priority-star">⭐</span>' : '') + '</td>'
      + '<td class="td-company">' + esc(l.c) + '<small>' + esc(l.cn || '—') + '</small></td>'
      + '<td style="font-size:11px">' + st + '</td>'
      + '<td style="font-size:10px;color:var(--text3)">' + (l.ty ? l.ty.split(';')[0] : '—') + '</td>'
      + '<td>' + statusBadge(l.cs) + '</td>'
      + '<td>' + tags + '</td>'
      + '<td style="text-align:center;color:' + (l.cc > 0 ? 'var(--accent)' : 'var(--text3)') + '">' + l.cc + '</td>'
      + '<td>' + lastContactBadge(l) + '</td>'
      + '<td onclick="event.stopPropagation()">' + callBtn + '</td>'
      + '</tr>';
  }).join('');
}
function renderPagination() {
  const total = Math.ceil(filteredLeads.length / PER_PAGE);
  const pg    = document.getElementById('pagination');
  if (total <= 1) { pg.innerHTML = ''; return; }
  let h = '<button class="page-btn" onclick="goPage(' + (currentPage-1) + ')" ' + (currentPage===1?'disabled':'') + '>◀</button>';
  const r = [];
  for (let i = Math.max(1, currentPage-2); i <= Math.min(total, currentPage+2); i++) r.push(i);
  if (r[0] > 1) { h += '<button class="page-btn" onclick="goPage(1)">1</button>'; if (r[0]>2) h += '<span style="color:var(--text3)">…</span>'; }
  r.forEach(p => { h += '<button class="page-btn ' + (p===currentPage?'active':'') + '" onclick="goPage(' + p + ')">' + p + '</button>'; });
  if (r[r.length-1] < total) { if (r[r.length-1]<total-1) h += '<span style="color:var(--text3)">…</span>'; h += '<button class="page-btn" onclick="goPage('+total+')">' + total + '</button>'; }
  h += '<button class="page-btn" onclick="goPage(' + (currentPage+1) + ')" ' + (currentPage===total?'disabled':'') + '>▶</button>';
  pg.innerHTML = h;
}
function goPage(p) {
  const t = Math.ceil(filteredLeads.length / PER_PAGE);
  if (p < 1 || p > t) return;
  currentPage = p;
  renderTable();
  renderPagination();
}

// ── QUICK CALL ────────────────────────────────────────────────
async function quickCall(id) {
  const lead = leads.find(l => l.id === id);
  if (!lead) return;
  lead.cc = (lead.cc || 0) + 1;
  lead.lc = new Date().toISOString();
  if (lead.cs === 'novo') lead.cs = 'contatado';
  applyFilters();
  saveLeadState(lead);
  logActivity(lead.id, lead.c, 'call', 'Call #' + lead.cc);
  showToast('📞 ' + lead.c.substring(0, 25));
}

// ── MODAL ─────────────────────────────────────────────────────
async function openModal(id) {
  const lead = leads.find(l => l.id === id);
  if (!lead) return;
  currentLead = lead;
  document.getElementById('modal-company').textContent = lead.c;
  document.getElementById('modal-sub').textContent = [lead.cn, lead.st ? (lead.st.split(' - ')[1] || '') : ''].filter(Boolean).join(', ') || '—';

  const salesHtml = lead.sl
    ? '<div class="sales-card"><div class="sales-card-val">$' + lead.sl.total.toFixed(2) + '</div><div class="sales-card-sub">' + lead.sl.count + ' orders · Rep: ' + esc(lead.sl.rep) + ' · Last: ' + esc(lead.sl.last_date) + '</div></div>'
    : '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;color:var(--text3);font-size:12px">No purchase history</div>';

  const days = daysSince(lead.lc);
  const lastContactInfo = days === null
    ? '<span style="color:var(--text3)">Never contacted</span>'
    : days === 0
      ? '<span style="color:var(--accent)">Contacted today</span>'
      : '<span style="color:' + (days > 7 ? 'var(--danger)' : 'var(--warn)') + '">Last contact: <strong>' + days + ' day' + (days > 1 ? 's' : '') + ' ago</strong></span>';

  const phoneHtml = lead.ph
    ? '<a href="tel:' + lead.ph.replace(/\D/g,'') + '" class="btn btn-primary" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none;padding:8px 14px;font-size:12px" title="Opens Intermedia">📞 Call: ' + esc(lead.ph) + '</a>'
    : '<span style="color:var(--text3);font-size:12px">No phone number</span>';

  const statusBtns = ['novo','contatado','proposta','cliente'].map(s => {
    const labels = { novo:'🔵 New', contatado:'🟡 Contacted', proposta:'🟣 Proposal', cliente:'🟢 Customer' };
    return '<button class="status-btn ' + (lead.cs === s ? 'sel' : '') + '" onclick="setStatus(\'' + s + '\')">' + labels[s] + '</button>';
  }).join('');

  document.getElementById('modal-body').innerHTML =
    '<div class="modal-section"><div class="modal-section-title">⏱ Last Contact</div><div style="padding:8px 0">' + lastContactInfo + '</div></div>'
    + '<div class="modal-section"><div class="modal-section-title">📞 Call via Intermedia</div>' + phoneHtml + '</div>'
    + '<div class="modal-section"><div class="modal-section-title">🔵 Status</div><div class="status-row" id="modal-status-row">' + statusBtns + '</div></div>'
    + '<div class="modal-section"><div class="modal-section-title">📝 Lead Info</div><div class="info-grid" id="lead-info-grid">' + (await renderEditableFields(lead)) + '</div></div>'
    + '<div class="modal-section"><div class="modal-section-title">⭐ Priority</div><label class="priority-toggle"><input type="checkbox" id="modal-priority" ' + (lead.pr ? 'checked' : '') + ' onchange="currentLead.pr=this.checked"><span>Mark as priority ⭐</span></label></div>'
    + '<div class="modal-section"><div class="modal-section-title">🏷 Tags</div>'
    + '<div class="tags-input-row"><input type="text" class="tags-input" id="tag-input" placeholder="Add tag..." onkeydown="if(event.key===\'Enter\'){addTag();event.preventDefault()}"><button class="btn btn-ghost" onclick="addTag()">+ Add</button></div>'
    + '<div class="tags-display" id="tags-display"></div>'
    + '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">'
    + ['callback','no answer','interested','unavailable','voicemail','speak with owner'].map(t => '<span class="chip" style="font-size:10px;padding:3px 8px" onclick="addTagQuick(\'' + t + '\')">' + t + '</span>').join('')
    + '</div></div>'
    + '<div class="modal-section"><div class="modal-section-title">📄 Notes</div><textarea class="modal-textarea" id="modal-comments" placeholder="General notes...">' + esc(lead.cm || '') + '</textarea></div>'
    + '<div class="modal-section"><div class="modal-section-title">📞 Call Log</div><div class="call-log">Total: <strong style="color:var(--accent)">' + (lead.cc || 0) + '</strong>' + (lead.lc ? ' · Last: <strong>' + new Date(lead.lc).toLocaleString('en-US') + '</strong>' : ' · None') + '</div></div>'
    + '<div class="modal-section"><div class="modal-section-title">📄 Quotes</div><div id="modal-quotes-list"><span style="font-size:12px;color:var(--text3)">Loading...</span></div></div>'
    + '<div class="modal-section"><div class="modal-section-title">💬 Comment Timeline</div>'
    + '<div class="tl-add"><textarea id="tl-new-text" placeholder="Add comment..."></textarea><button class="btn btn-primary" style="height:60px" onclick="addTimelineEntry()">+ Add</button></div>'
    + '<div style="margin-top:12px" id="timeline-list"></div></div>';

  renderTagsDisplay();
  renderTimeline();
  loadLeadQuotes(lead.id);

  const deleteBtn = hasPermission('delete_leads')
    ? '<button class="btn btn-danger" onclick="deleteLead(' + lead.id + ')" style="margin-right:auto">🗑 Delete Lead</button>'
    : '';
  const quoteBtn = hasPermission('create_quotes')
    ? '<button class="btn btn-ghost" onclick="openQuoteModal(' + lead.id + ')">📄 Quote</button>'
    : '';
  document.getElementById('modal-footer').innerHTML =
    deleteBtn
    + quoteBtn
    + '<button class="btn btn-ghost" onclick="registerCall()">📞 Log Call</button>'
    + '<button class="btn btn-primary" onclick="saveModal()">💾 Save</button>';

  document.getElementById('modal').style.display = 'flex';
}

// ── EDITABLE FIELDS ───────────────────────────────────────────
function renderPipelineDropdown(lead) {
  const canEdit = currentProfile?.role === 'admin' || hasPermission('edit_segmentation');
  const options_list = segmentations.length
    ? segmentations
    : [...new Set(leads.map(l => l.p).filter(Boolean))].sort();
  const current = lead.p || '';

  if (!canEdit) {
    return '<div class="info-item"><div class="info-item-lbl">Segmentation</div>'
      + '<div class="info-item-val" style="font-size:12px;color:var(--text2)">' + esc(current || '—') + '</div></div>';
  }

  const options = ['<option value="">— No segmentation —</option>']
    .concat(options_list.map(p => '<option value="' + esc(p) + '"' + (p === current ? ' selected' : '') + '>' + esc(p) + '</option>'));
  return '<div class="info-item"><div class="info-item-lbl">Segmentation</div>'
    + '<div class="info-item-val"><select class="edit-field edit-select" data-key="p" onchange="updateLeadPipeline(this)">'
    + options.join('') + '</select></div></div>';
}

function renderOwnerDropdown(currentOwner) {
  const canReassign = currentProfile?.role === 'admin' || hasPermission('reassign_leads');
  const current = currentOwner || '';

  if (!canReassign) {
    return '<div class="info-item"><div class="info-item-lbl">Owner</div>'
      + '<div class="info-item-val" style="font-size:12px;color:var(--text2)">' + esc(current || '— Unassigned —') + '</div></div>';
  }

  const vendors = allUsers.filter(u => u.role === 'vendor' || u.role === 'admin').map(u => u.name).sort();
  if (current && !vendors.includes(current)) vendors.push(current);
  const options = ['<option value="">— Unassigned —</option>']
    .concat(vendors.map(v => '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>'));
  return '<div class="info-item"><div class="info-item-lbl">Owner</div>'
    + '<div class="info-item-val"><select class="edit-field edit-select" data-key="responsible" onchange="updateLeadField(this)">'
    + options.join('') + '</select></div></div>';
}

async function renderMktTagDropdown(lead) {
  await loadMktTagTypes();
  const current = lead.mkt_tag || '';
  const canEdit = currentProfile?.role === 'admin' || hasPermission('edit_mkt_tag');

  if (!canEdit) {
    return '<div class="info-item"><div class="info-item-lbl">🏷 MKT Tag</div>'
      + '<div class="info-item-val" style="font-size:12px;color:var(--text2)">' + esc(current || '—') + '</div></div>';
  }

  const options = ['<option value="">— No MKT Tag —</option>']
    .concat((mktTagTypes || []).map(t =>
      '<option value="' + esc(t) + '"' + (t === current ? ' selected' : '') + '>' + esc(t) + '</option>'
    ));
  return '<div class="info-item"><div class="info-item-lbl">🏷 MKT Tag</div>'
    + '<div class="info-item-val"><select class="edit-field edit-select" data-key="mkt_tag" onchange="updateMktTagFromModal(this)">'
    + options.join('') + '</select></div></div>';
}

async function updateMktTagFromModal(select) {
  if (!currentLead) return;
  const newVal = select.value;
  currentLead.mkt_tag = newVal;
  await saveLeadState(currentLead);
  showToast(newVal ? '🏷 MKT Tag "' + newVal + '" saved' : '🏷 MKT Tag removed');
}

async function renderEditableFields(lead) {
  const field = (label, key, val, type) =>
    '<div class="info-item"><div class="info-item-lbl">' + label + '</div>'
    + '<div class="info-item-val"><input type="' + (type||'text') + '" class="edit-field" data-key="' + key + '" value="' + esc(val||'') + '" placeholder="' + label + '..." onchange="updateLeadField(this)"></div></div>';

  const mktTagHtml = await renderMktTagDropdown(lead);

  return field('Company',     'c',           lead.c)
    + field('Contact',        'cn',          lead.cn)
    + field('Email',          'em',          lead.em, 'email')
    + field('Phone',          'ph',          lead.ph, 'tel')
    + renderOwnerDropdown(lead.responsible || lead.r)
    + field('Type',           'ty',          lead.ty)
    + renderPipelineDropdown(lead)
    + '<div class="info-item"><div class="info-item-lbl">State</div><div class="info-item-val" style="font-size:11px;color:var(--text3)">' + esc(lead.st || '—') + '</div></div>'
    + mktTagHtml;
}

async function updateLeadPipeline(select) {
  if (!currentLead) return;
  const oldVal = currentLead.p;
  const newVal = select.value;
  if (oldVal === newVal) return;
  currentLead.p = newVal;
  const { error } = await sb.from('leads')
    .update({ pipeline: newVal })
    .eq('id', currentLead.id);
  if (error) { showToast('❌ Error updating pipeline'); return; }
  logActivity(currentLead.id, currentLead.c, 'field_edit', 'pipeline: "' + oldVal + '" → "' + newVal + '"');
  showToast('✅ Pipeline updated');
  applyFilters();
}

async function updateLeadField(input) {
  if (!currentLead) return;
  // Check if user can edit this lead
  const isOwn = (currentLead.responsible || currentLead.r) === currentProfile?.name;
  if (!isOwn && !hasPermission('edit_any_lead')) {
    showToast('⚠️ No permission to edit this lead');
    return;
  }
  const key    = input.dataset.key;
  const oldVal = currentLead[key];
  const newVal = input.value;
  if (oldVal === newVal) return;
  currentLead[key] = newVal;
  if (key === 'responsible') {
    currentLead.responsible = newVal;
    const { error } = await sb.from('leads').update({ responsible: newVal || '' }).eq('id', currentLead.id);
    if (error) { showToast('❌ Error saving: ' + error.message); return; }
    await saveLeadState(currentLead);
    logActivity(currentLead.id, currentLead.c, 'transfer', (oldVal||'Unassigned') + ' → ' + (newVal||'Unassigned'));
    showToast('🔀 Reassigned to ' + (newVal || 'Unassigned'));
  } else {
    const { error } = await sb.from('leads').update({ [key === 'c' ? 'company' : key === 'cn' ? 'contact' : key === 'em' ? 'email' : key === 'ph' ? 'phone' : key === 'ty' ? 'type' : key]: newVal }).eq('id', currentLead.id);
    if (error) console.warn('leads update error:', error.message);
    await saveLeadState(currentLead);
    logActivity(currentLead.id, currentLead.c, 'field_edit', key + ': "' + oldVal + '" → "' + newVal + '"');
    showToast('✏️ ' + key + ' updated');
  }
  applyFilters();
}

// ── TIMELINE ──────────────────────────────────────────────────
function renderTimeline() {
  const el = document.getElementById('timeline-list');
  if (!el || !currentLead) return;
  const entries = currentLead.tl || [];
  if (!entries.length) { el.innerHTML = '<div class="tl-empty">No comments yet.</div>'; return; }
  const isAdmin = currentProfile?.role === 'admin';
  el.innerHTML = '<div class="timeline">' + [...entries].reverse().map((x, ri) => {
    const realIdx = (currentLead.tl.length - 1) - ri;
    const delBtn  = isAdmin
      ? '<button onclick="deleteTimelineEntry(' + realIdx + ')" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:11px;padding:2px 6px;border-radius:4px;opacity:.7" title="Remove">🗑</button>'
      : '';
    return '<div class="tl-entry"><div class="tl-dot"></div><div class="tl-body">'
      + '<div class="tl-meta"><span class="tl-vendor">👤 ' + esc(x.v || '—') + '</span>'
      + '<span class="tl-date">' + new Date(x.ts).toLocaleString('en-US') + '</span>' + delBtn + '</div>'
      + '<div class="tl-text">' + esc(x.txt) + '</div></div></div>';
  }).join('') + '</div>';
}

async function deleteTimelineEntry(idx) {
  if (!currentLead || currentProfile?.role !== 'admin') return;
  if (!confirm('Remove this comment?')) return;
  const removed = currentLead.tl.splice(idx, 1)[0];
  renderTimeline();
  await saveLeadState(currentLead);
  logActivity(currentLead.id, currentLead.c, 'comment_deleted', 'Removed: "' + (removed?.txt || '').substring(0, 50) + '"');
  showToast('🗑 Comment removed');
}

function addTimelineEntry() {
  if (!currentLead) return;
  const inp = document.getElementById('tl-new-text');
  const txt = inp.value.trim();
  if (!txt) { showToast('⚠️ Type a comment first'); return; }
  if (!currentLead.tl) currentLead.tl = [];
  currentLead.tl.push({ ts: new Date().toISOString(), v: currentProfile?.name || '—', txt });
  inp.value = '';
  renderTimeline();
  logActivity(currentLead.id, currentLead.c, 'comment', txt.substring(0, 80));
  showToast('💬 Added!');
}

function addTag() {
  const inp = document.getElementById('tag-input');
  if (!inp || !currentLead) return;
  const val = inp.value.trim();
  if (!val) return;
  if (!currentLead.tg) currentLead.tg = [];
  if (!currentLead.tg.includes(val)) currentLead.tg.push(val);
  inp.value = '';
  renderTagsDisplay();
}
function addTagQuick(tag) {
  if (!currentLead) return;
  if (!currentLead.tg) currentLead.tg = [];
  if (!currentLead.tg.includes(tag)) currentLead.tg.push(tag);
  renderTagsDisplay();
}
function removeTag(i) {
  if (currentLead) { currentLead.tg.splice(i, 1); renderTagsDisplay(); }
}
function renderTagsDisplay() {
  const el = document.getElementById('tags-display');
  if (!el || !currentLead) return;
  el.innerHTML = (currentLead.tg || []).map((t, i) =>
    '<span class="tag-rm">' + esc(t) + '<button onclick="removeTag(' + i + ')">×</button></span>'
  ).join('');
}
function setStatus(s) {
  if (!currentLead) return;
  const old = currentLead.cs;
  currentLead.cs = s;
  if (s === 'cliente') { currentLead.cv = true; currentLead.lc = new Date().toISOString(); }
  document.querySelectorAll('#modal-status-row .status-btn').forEach(b =>
    b.classList.toggle('sel', b.getAttribute('onclick').includes("'" + s + "'"))
  );
  if (old !== s) logActivity(currentLead.id, currentLead.c, 'status_change', old + ' → ' + s);
}
async function registerCall() {
  if (!currentLead) return;
  currentLead.cc = (currentLead.cc || 0) + 1;
  currentLead.lc = new Date().toISOString();
  if (currentLead.cs === 'novo') currentLead.cs = 'contatado';
  logActivity(currentLead.id, currentLead.c, 'call', 'Call #' + currentLead.cc);
  showToast('📞 Call logged!');
  const cl = document.querySelector('.call-log');
  if (cl) cl.innerHTML = 'Total: <strong style="color:var(--accent)">' + currentLead.cc + '</strong> · Last: <strong>' + new Date(currentLead.lc).toLocaleString('en-US') + '</strong>';
}
async function saveModal() {
  if (!currentLead) return;
  const cm = document.getElementById('modal-comments');
  if (cm) currentLead.cm = cm.value;
  await saveLeadState(currentLead);
  closeModal();
  applyFilters();
  showToast('✅ Saved!');
}
function closeModal() { document.getElementById('modal').style.display = 'none'; currentLead = null; }
function closeModalOutside(e) { if (e.target === document.getElementById('modal')) closeModal(); }

// ── STATS ─────────────────────────────────────────────────────
function updateTopbarStats() {
  document.getElementById('ts-total').textContent    = filteredLeads.length.toLocaleString();
  document.getElementById('ts-calls').textContent    = sessionCalls;
  document.getElementById('ts-conv').textContent     = leads.filter(l => l.cs === 'cliente').length;
  document.getElementById('ts-priority').textContent = leads.filter(l => l.pr).length;
}
function updateProgress() {
  const pct = Math.min(100, (sessionCalls / 250) * 100);
  document.getElementById('prog-fill').style.width = pct + '%';
  document.getElementById('calls-done').textContent = sessionCalls + ' calls';
  document.getElementById('ts-calls').textContent   = sessionCalls;
}
function updateMiniStats() {
  document.getElementById('mini-shown').textContent    = filteredLeads.length;
  document.getElementById('mini-priority').textContent = filteredLeads.filter(l => l.pr).length;
  document.getElementById('mini-clients').textContent  = filteredLeads.filter(l => l.cs === 'cliente').length;
  document.getElementById('mini-calls').textContent    = filteredLeads.reduce((s, l) => s + (l.cc || 0), 0);
}

// ── DASHBOARD ─────────────────────────────────────────────────
function renderDashboard() {
  const isAdmin   = currentProfile?.role === 'admin';
  const pool      = isAdmin ? leads : getMyLeads();
  const withSales = pool.filter(l => l.sl).length;
  const totalRev  = pool.filter(l => l.sl).reduce((s, l) => s + (l.sl.total || 0), 0);
  const withPhone = pool.filter(l => l.ph).length;
  const noContact = pool.filter(l => !l.lc).length;
  const stale     = pool.filter(l => (daysSince(l.lc) || 0) > 7).length;
  const totalCalls = pool.reduce((s, l) => s + (l.cc || 0), 0);

  document.getElementById('kpi-grid').innerHTML =
    '<div class="kpi-card blue"><div class="kpi-card-val">' + pool.length.toLocaleString() + '</div><div class="kpi-card-lbl">' + (isAdmin ? 'All' : 'My') + ' Leads</div></div>'
    + '<div class="kpi-card teal"><div class="kpi-card-val">' + totalCalls.toLocaleString() + '</div><div class="kpi-card-lbl">Total Calls</div></div>'
    + '<div class="kpi-card yellow"><div class="kpi-card-val">' + withSales + '</div><div class="kpi-card-lbl">With Purchases</div></div>'
    + '<div class="kpi-card purple"><div class="kpi-card-val">' + withPhone.toLocaleString() + '</div><div class="kpi-card-lbl">With Phone</div></div>'
    + '<div class="kpi-card danger"><div class="kpi-card-val">' + noContact + '</div><div class="kpi-card-lbl">Never Contacted</div></div>'
    + '<div class="kpi-card warn"><div class="kpi-card-val">' + stale + '</div><div class="kpi-card-lbl">No Contact 7d+</div></div>';

  const byPipe = {};
  pool.forEach(l => { byPipe[l.p] = (byPipe[l.p] || 0) + 1; });
  const pipeE   = Object.entries(byPipe).sort((a,b) => b[1]-a[1]);
  const maxPipe = pipeE[0]?.[1] || 1;

  const byRepCalls = window._callsByProfile || {};
  const callsE   = Object.entries(byRepCalls).sort((a,b) => b[1]-a[1]).slice(0,8);
  const maxCalls = callsE[0]?.[1] || 1;

  document.getElementById('charts-row').innerHTML =
    '<div class="chart-card"><div class="chart-title">📊 Pipeline</div><div class="bar-chart">'
    + pipeE.slice(0,6).map(([p,v]) =>
      '<div class="bar-row"><div class="bar-label">' + p.split(' - ').pop() + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:' + (v/maxPipe*100).toFixed(0) + '%;background:linear-gradient(90deg,#a78bfa,#c4b5fd)"></div></div>'
      + '<div class="bar-val">' + v + '</div></div>'
    ).join('') + '</div></div>'
    + (callsE.length
      ? '<div class="chart-card"><div class="chart-title">📞 Calls by Vendor</div><div class="bar-chart">'
        + callsE.map(([r,v]) =>
          '<div class="bar-row"><div class="bar-label">' + esc(r||'—') + '</div>'
          + '<div class="bar-track"><div class="bar-fill" style="width:' + (v/maxCalls*100).toFixed(0) + '%;background:linear-gradient(90deg,#34d399,#6ee7b7)"></div></div>'
          + '<div class="bar-val">' + v + '</div></div>'
        ).join('') + '</div></div>'
      : '');
}

// ── ADMIN ─────────────────────────────────────────────────────
let allUsers = [], draggingId = null;
function toggleAdminView() {
  const goAdmin = document.getElementById('admin-panel').style.display !== 'flex';
  document.getElementById('main').style.display        = goAdmin ? 'none' : 'flex';
  document.getElementById('sidebar').style.display     = goAdmin ? 'none' : '';
  document.getElementById('admin-panel').style.display = goAdmin ? 'flex' : 'none';
  document.getElementById('mkt-panel').style.display   = 'none';
  document.getElementById('btn-admin').textContent     = goAdmin ? '📋 CRM' : '🛡 Admin';
  document.getElementById('btn-mkt').textContent       = '📧 MKT';
  if (goAdmin) loadAdminData();
}
async function loadAdminData() {
  const { data } = await sb.from('profiles').select('*').order('name');
  allUsers = data || [];
  if (window._callsByIntermediaName) {
    await buildCallsByProfile(window._callsByIntermediaName);
  } else {
    await loadIntermedaCallCounts();
  }
  renderUsersTable();
  renderKanban();
  renderPermissionsTable();
  renderSegmentationList();
  loadCallsLog();
  loadActivityLog();
}
function renderUsersTable() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;
  const lpu = {};
  leads.forEach(l => {
    const r = l.responsible || l.r;
    if (r) lpu[r] = (lpu[r] || 0) + 1;
  });
  const cpu = window._callsByProfile || {};
  tbody.innerHTML = allUsers.map(u =>
    '<tr><td style="font-weight:500">' + esc(u.name) + '</td>'
    + '<td>'
      + '<select onchange="changeUserRole(\'' + u.id + '\',this.value,\'' + esc(u.name) + '\')" style="background:var(--bg);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:3px 7px;font-size:11px;cursor:pointer">'
      + ['vendor','admin','mkt'].map(r => '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + r + '</option>').join('')
      + '</select>'
    + '</td>'
    + '<td style="color:var(--accent);font-weight:600">' + (lpu[u.name]||0) + '</td>'
    + '<td style="color:#34d399;font-weight:600">📞 ' + (cpu[u.name]||0) + '</td>'
    + '<td><button onclick="deleteUser(\'' + u.id + '\',\'' + esc(u.name) + '\')" style="background:none;border:1px solid var(--danger);color:var(--danger);border-radius:6px;padding:2px 8px;font-size:10px;cursor:pointer" title="Delete user">🗑</button></td></tr>'
  ).join('');
}

async function changeUserRole(userId, newRole, userName) {
  const { error } = await sb.from('profiles').update({ role: newRole }).eq('id', userId);
  if (error) { showToast('❌ ' + error.message); await loadAdminData(); return; }
  const u = allUsers.find(u => u.id === userId);
  if (u) u.role = newRole;
  showToast('✅ ' + userName + ' → ' + newRole);
  logActivity(null, null, 'field_edit', 'Changed role: ' + userName + ' → ' + newRole);
}
function renderKanban() {
  const vendors = allUsers.filter(u => u.role === 'vendor');
  const kd = {};
  vendors.forEach(u => { kd[u.name] = leads.filter(l => (l.responsible||l.r) === u.name).slice(0,15); });
  const unassigned = leads.filter(l => { const r = l.responsible||l.r; return !r || !allUsers.find(u => u.name===r); }).slice(0,15);
  if (unassigned.length) kd['Unassigned'] = unassigned;
  const wrap = document.getElementById('kanban-wrap');
  if (!wrap) return;
  const stateEmoji = { novo:'🔵', contatado:'🟡', proposta:'🟣', cliente:'🟢' };
  wrap.innerHTML = Object.entries(kd).map(([vendor, vl]) =>
    '<div class="kanban-col" data-vendor="' + esc(vendor) + '">'
    + '<div class="kanban-col-header">' + esc(vendor) + '<span>' + vl.length + (vl.length>=15?'+':'') + '</span></div>'
    + '<div class="kanban-col-body" ondragover="onDragOver(event)" ondrop="onDrop(event,\'' + esc(vendor) + '\')" ondragleave="onDragLeave(event)">'
    + vl.map(l =>
      '<div class="kanban-card" draggable="true" ondragstart="onDragStart(event,' + l.id + ')">'
      + '<div class="kanban-card-name">' + esc(l.c) + '</div>'
      + '<div class="kanban-card-state">' + (stateEmoji[l.cs]||'⚪') + ' ' + l.cs + '</div></div>'
    ).join('')
    + '</div></div>'
  ).join('');
}
function onDragStart(e, id) { draggingId = id; e.currentTarget.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; }
function onDragOver(e)  { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function onDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
async function onDrop(e, vendor) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  if (!draggingId) return;
  const lead = leads.find(l => l.id === draggingId); if (!lead) return;
  const old = lead.responsible || lead.r;
  lead.responsible = vendor;
  await saveLeadState(lead);
  logActivity(lead.id, lead.c, 'transfer', old + ' → ' + vendor);
  renderKanban();
  showToast('✅ "' + lead.c.substring(0,20) + '" → ' + vendor);
  draggingId = null;
}
async function loadCallsLog() {
  const el = document.getElementById('calls-list');
  if (!el) return;
  const { data } = await sb.from('intermedia_call_log')
    .select('*')
    .order('called_at', { ascending: false })
    .limit(50);
  if (!data || !data.length) {
    el.innerHTML = '<div style="color:var(--text3);padding:20px;text-align:center">No calls synced yet</div>';
    return;
  }
  const leadMap = {};
  leads.forEach(l => { leadMap[l.id] = l.c; });
  el.innerHTML = data.map(c => {
    const emoji     = c.direction === 'outbound' ? '📞' : '📲';
    const durSec    = c.duration || 0;
    const durStr    = durSec < 1 ? 'missed' : durSec < 60 ? durSec + 's' : Math.floor(durSec/60) + 'm ' + (durSec%60) + 's';
    const leadName  = leadMap[c.lead_id] || '—';
    const timeStr   = new Date(c.called_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    return '<div class="activity-item">'
      + '<div class="act-icon">' + emoji + '</div>'
      + '<div class="act-body"><strong>' + esc(c.user_name||'Unknown') + '</strong>'
      + ' · ' + (c.direction === 'outbound' ? 'Outbound' : 'Inbound') + ' · ' + durStr
      + '<br><span style="color:var(--text3)">Lead: <strong>' + esc(leadName) + '</strong></span>'
      + '</div>'
      + '<div class="act-time">' + timeStr + '</div>'
      + '</div>';
  }).join('');
}

async function loadActivityLog() {
  const el = document.getElementById('activity-list');
  if (!el) return;
  const { data } = await sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(100);
  if (!data || !data.length) { el.innerHTML = '<div style="color:var(--text3);padding:20px;text-align:center">No activity yet</div>'; return; }
  const icons = { call:'📞', status_change:'🔄', comment:'💬', transfer:'🔀', login:'🔑', logout:'🚪', idle:'😴', idle_return:'👋', field_edit:'✏️', comment_deleted:'🗑' };
  el.innerHTML = data.map(a =>
    '<div class="activity-item">'
    + '<div class="act-icon">' + (icons[a.action] || '📝') + '</div>'
    + '<div class="act-body"><strong>' + esc(a.user_name||'—') + '</strong> · ' + a.action.replace(/_/g,' ')
    + (a.lead_name ? ' on <strong>' + esc(a.lead_name.substring(0,25)) + '</strong>' : '')
    + (a.detail    ? '<br><span style="color:var(--text3)">' + esc(a.detail.substring(0,80)) + '</span>' : '')
    + '</div>'
    + '<div class="act-time">' + new Date(a.created_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) + '</div>'
    + '</div>'
  ).join('');
}
async function createUser() {
  const name  = document.getElementById('new-name').value.trim();
  const email = document.getElementById('new-email').value.trim();
  const pass  = document.getElementById('new-pass').value;
  const role  = document.getElementById('new-role').value;
  if (!name || !email || !pass) { showToast('⚠️ Fill in all fields'); return; }
  const { data, error } = await sb.auth.signUp({ email, password: pass });
  if (error) { showToast('❌ ' + error.message); return; }
  if (data.user) await sb.from('profiles').insert({ id: data.user.id, name, role });
  showToast('✅ User created: ' + email);
  document.getElementById('new-name').value  = '';
  document.getElementById('new-email').value = '';
  document.getElementById('new-pass').value  = '';
  await loadAdminData();
}

// ── ANALYTICS ─────────────────────────────────────────────────
let analyticsDateFrom = null, analyticsDateTo = null;

function setPreset(preset, btn) {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const fmt = d => d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());

  if (preset === 'custom') {
    document.getElementById('date-custom').style.display = 'flex';
    return;
  }
  document.getElementById('date-custom').style.display = 'none';

  const to = new Date(now);
  let from = new Date(now);
  if (preset === '7d')  { from.setDate(to.getDate() - 6); }
  if (preset === '30d') { from.setDate(to.getDate() - 29); }
  if (preset === '90d') { from.setDate(to.getDate() - 89); }
  if (preset === 'mtd') { from = new Date(now.getFullYear(), now.getMonth(), 1); }

  analyticsDateFrom = fmt(from);
  analyticsDateTo   = fmt(to);
  document.getElementById('date-from').value = analyticsDateFrom;
  document.getElementById('date-to').value   = analyticsDateTo;
  loadAnalytics();
}

async function loadAnalytics() {
  if (currentProfile?.role !== 'admin') return;

  const fromInput = document.getElementById('date-from').value;
  const toInput   = document.getElementById('date-to').value;
  if (fromInput) analyticsDateFrom = fromInput;
  if (toInput)   analyticsDateTo   = toInput;
  if (!analyticsDateFrom || !analyticsDateTo) return;

  const fromDate = new Date(analyticsDateFrom + 'T00:00:00');
  const toDate   = new Date(analyticsDateTo   + 'T23:59:59');

  const { data: callLogs } = await sb.from('intermedia_call_log')
    .select('*')
    .gte('called_at', fromDate.toISOString())
    .lte('called_at', toDate.toISOString());
  const calls = callLogs || [];

  const pool = leads;
  const leadMap = {};
  pool.forEach(l => { leadMap[l.id] = l; });

  function canonicalName(raw) {
    if (!raw) return 'Unassigned';
    const r = raw.trim();
    if (allUsers.length) {
      const match = allUsers.find(u => {
        const p = u.name.toLowerCase(), rr = r.toLowerCase();
        const words = rr.split(' ').filter(w => w.length > 3);
        return p === rr || p.includes(rr) || rr.includes(p) || words.some(w => p.includes(w));
      });
      if (match) return match.name;
    }
    return r;
  }

  const vendors = {};
  pool.forEach(l => {
    const name = canonicalName(l.responsible || l.r);
    if (!vendors[name]) vendors[name] = { name, leads:0, calls:0, durTotal:0, contacted:0, converted:0, revenue:0 };
    vendors[name].leads++;
    if (l.lc) vendors[name].contacted++;
    if (l.cv) vendors[name].converted++;
    if (l.sl) vendors[name].revenue += (l.sl.total || 0);
  });

  calls.forEach(c => {
    const lead = leadMap[c.lead_id];
    if (!lead) return;
    const name = canonicalName(lead.responsible || lead.r);
    if (!vendors[name]) vendors[name] = { name, leads:0, calls:0, durTotal:0, contacted:0, converted:0, revenue:0 };
    vendors[name].calls++;
    vendors[name].durTotal += (c.duration || 0);
  });

  const vList = Object.values(vendors).filter(v => v.leads > 0).sort((a,b) => b.calls - a.calls);

  const totalLeads    = pool.length;
  const totalRevenue  = pool.filter(l=>l.sl).reduce((s,l) => s+(l.sl.total||0), 0);
  const totalCalls    = calls.length;
  const totalDur      = calls.reduce((s,c) => s+(c.duration||0), 0);
  const avgDur        = totalCalls ? Math.round(totalDur / totalCalls) : 0;
  const totalConverted = pool.filter(l=>l.cv).length;
  const convRate      = totalLeads ? ((totalConverted/totalLeads)*100).toFixed(1) : 0;

  const fmtDur = s => { if(!s) return '—'; const m=Math.floor(s/60); return m?m+'m '+(s%60)+'s':s+'s'; };

  document.getElementById('analytics-kpis').innerHTML =
    kpi('blue',   totalLeads.toLocaleString(), 'Total Leads')
    + kpi('teal',   totalCalls.toLocaleString(), 'Calls (period)')
    + kpi('purple', fmtDur(avgDur), 'Avg Call Duration')
    + kpi('yellow', totalConverted, 'Converted')
    + kpi('warn',   convRate+'%', 'Conv. Rate');

  function kpi(cls, val, lbl) {
    return '<div class="kpi-card '+cls+'"><div class="kpi-card-val">'+val+'</div><div class="kpi-card-lbl">'+lbl+'</div></div>';
  }

  const maxRev  = Math.max(...vList.map(v=>v.revenue), 1);
  const maxCall = Math.max(...vList.map(v=>v.calls), 1);

  document.getElementById('analytics-charts-1').innerHTML =
    '<div class="chart-card"><div class="chart-title">📞 Calls by Vendor</div><div class="bar-chart">'
    + vList.slice(0,8).map(v =>
        '<div class="bar-row"><div class="bar-label">'+esc(v.name)+'</div>'
        +'<div class="bar-track"><div class="bar-fill" style="width:'+(v.calls/maxCall*100).toFixed(0)+'%;background:linear-gradient(90deg,#34d399,#6ee7b7)"></div></div>'
        +'<div class="bar-val">'+v.calls+'</div></div>'
      ).join('') + '</div></div>';

  const statusCounts = { novo:0, contatado:0, proposta:0, cliente:0 };
  pool.forEach(l => { if(statusCounts[l.cs] !== undefined) statusCounts[l.cs]++; });
  const statusLabels = { novo:'🔵 New', contatado:'🟡 Contacted', proposta:'🟣 Proposal', cliente:'🟢 Client' };
  const maxStatus = Math.max(...Object.values(statusCounts), 1);

  const outbound = calls.filter(c => c.direction === 'outbound').length;
  const inbound  = calls.filter(c => c.direction === 'inbound').length;
  const missed   = calls.filter(c => (c.duration||0) < 5).length;
  const answered = calls.length - missed;

  document.getElementById('analytics-charts-2').innerHTML =
    '<div class="chart-card"><div class="chart-title">🔄 Lead Status Funnel</div><div class="bar-chart">'
    + Object.entries(statusCounts).map(([s,v]) =>
        '<div class="bar-row"><div class="bar-label">'+statusLabels[s]+'</div>'
        +'<div class="bar-track"><div class="bar-fill" style="width:'+(v/maxStatus*100).toFixed(0)+'%;background:linear-gradient(90deg,#818cf8,#a78bfa)"></div></div>'
        +'<div class="bar-val">'+v+'</div></div>'
      ).join('') + '</div></div>'
    + '<div class="chart-card"><div class="chart-title">📊 Call Breakdown (period)</div><div class="bar-chart">'
    + (totalCalls === 0
        ? '<div style="color:var(--text3);padding:20px;text-align:center">No calls in this period</div>'
        : [
            ['📞 Outbound', outbound, '#60a5fa'],
            ['📲 Inbound',  inbound,  '#34d399'],
            ['✅ Answered', answered, '#a78bfa'],
            ['📵 Missed',   missed,   '#f87171'],
          ].map(([lbl,v,clr]) =>
            '<div class="bar-row"><div class="bar-label">'+lbl+'</div>'
            +'<div class="bar-track"><div class="bar-fill" style="width:'+(v/totalCalls*100).toFixed(0)+'%;background:'+clr+'"></div></div>'
            +'<div class="bar-val">'+v+'</div></div>'
          ).join('')
      ) + '</div></div>';

  document.getElementById('vendor-tbody').innerHTML = vList.map(v => {
    const avgCallDur = v.calls ? Math.round(v.durTotal / v.calls) : 0;
    const cr = v.leads ? ((v.converted/v.leads)*100).toFixed(1) : 0;
    const crClass = cr >= 20 ? 'high' : cr >= 10 ? 'mid' : 'low';
    return '<tr>'
      + '<td><strong>'+esc(v.name)+'</strong></td>'
      + '<td class="num">'+v.leads+'</td>'
      + '<td class="num">'+v.calls+'</td>'
      + '<td class="num">'+fmtDur(avgCallDur)+'</td>'
      + '<td class="num">'+v.contacted+'</td>'
      + '<td class="num">'+v.converted+'</td>'
      + '<td class="num conv-rate '+crClass+'">'+cr+'%</td>'
      + '</tr>';
  }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:20px">No data</td></tr>';
}

// ── CSV EXPORT ────────────────────────────────────────────────
function exportCSV() {
  const isAdmin = currentProfile?.role === 'admin';
  const pool = isAdmin ? leads : getMyLeads();
  const rows = [
    ['ID', 'Company', 'Contact', 'Email', 'Phone', 'Owner', 'Segmentation', 'Type', 'Status', 'State', 'Calls', 'Last Contact', 'Tags', 'MKT Tag']
  ];
  pool.forEach(l => {
    rows.push([
      l.id,
      l.c || '',
      l.cn || '',
      l.em || '',
      l.ph || '',
      l.responsible || l.r || '',
      l.p || '',
      l.ty || '',
      l.cs || '',
      l.st || '',
      l.cc || 0,
      l.lc ? new Date(l.lc).toLocaleDateString('en-US') : '',
      (l.tg || []).join('; '),
      l.mkt_tag || ''
    ]);
  });
  const esc2 = v => '"' + String(v).replace(/"/g, '""') + '"';
  const csv = rows.map(r => r.map(esc2).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'floraforce_leads_' + new Date().toISOString().substring(0,10) + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  showToast('📥 CSV exported — ' + pool.length + ' leads');
}

// ── MKT PANEL ─────────────────────────────────────────────────
const MC_PROXY = 'https://zsgoocrqhzndghpseqtj.supabase.co/functions/v1/mailchimp-proxy';
let mktTagTypes = [];
let mktSortCol = 'c', mktSortDir = 1, mktSearch = '';

async function mcCall(action, payload = {}) {
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(MC_PROXY, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + session.access_token
    },
    body: JSON.stringify({ action, ...payload })
  });
  return res.json();
}

async function loadMktTagTypes() {
  const { data } = await sb.from('app_settings')
    .select('value').eq('key', 'mkt_tag_types').single();
  try {
    mktTagTypes = data?.value ? JSON.parse(data.value) : ['VIP', 'Cold', 'Hot', 'Prospect', 'Partner'];
  } catch(e) {
    mktTagTypes = ['VIP', 'Cold', 'Hot', 'Prospect', 'Partner'];
  }
}

async function saveMktTagTypes() {
  await sb.from('app_settings').upsert(
    { key: 'mkt_tag_types', value: JSON.stringify(mktTagTypes) },
    { onConflict: 'key' }
  );
}

function renderMktTagManager() {
  const el = document.getElementById('mkt-tag-manager');
  if (!el) return;
  el.innerHTML = mktTagTypes.length
    ? mktTagTypes.map((t, i) =>
        '<span style="display:inline-flex;align-items:center;gap:4px;background:var(--accent-dim);color:var(--accent);border:1px solid rgba(74,222,128,.25);border-radius:20px;padding:3px 10px;font-size:11px;font-weight:500">'
        + esc(t)
        + '<button onclick="removeMktTagType(' + i + ')" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:13px;line-height:1;padding:0 0 0 4px" title="Remove">×</button>'
        + '</span>'
      ).join('')
    : '<span style="color:var(--text3);font-size:12px">No tags yet — add one below</span>';
}

async function addMktTagType() {
  const inp = document.getElementById('mkt-new-tag-type');
  const val = inp.value.trim();
  if (!val) return;
  if (mktTagTypes.includes(val)) { showToast('⚠️ Tag already exists'); return; }
  mktTagTypes.push(val);
  inp.value = '';
  await saveMktTagTypes();
  renderMktTagManager();
  updateMktTagFilter();
  refreshMktPreview();
  showToast('✅ Tag "' + val + '" added');
}

async function removeMktTagType(i) {
  const removed = mktTagTypes.splice(i, 1)[0];
  await saveMktTagTypes();
  renderMktTagManager();
  updateMktTagFilter();
  refreshMktPreview();
  showToast('🗑 Tag "' + removed + '" removed');
}

function updateMktTagFilter() {
  const sel = document.getElementById('mkt-filter-tag');
  if (!sel) return;
  sel.innerHTML = '<option value="">All Tags</option>'
    + mktTagTypes.map(t => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join('');
}

function toggleMktView() {
  const goMkt = document.getElementById('mkt-panel').style.display !== 'flex';
  document.getElementById('main').style.display        = goMkt ? 'none' : '';
  document.getElementById('sidebar').style.display     = goMkt ? 'none' : '';
  document.getElementById('admin-panel').style.display = 'none';
  document.getElementById('mkt-panel').style.display   = goMkt ? 'flex' : 'none';
  document.getElementById('btn-mkt').textContent       = goMkt ? '📋 CRM' : '📧 MKT';
  document.getElementById('btn-admin').textContent     = '🛡 Admin';
  if (goMkt) loadMktPanel();
}

async function loadMktPanel() {
  await loadMktTagTypes();

  const pipeEl = document.getElementById('mkt-filter-segmentation');
  const pipes = segmentations.length ? segmentations : [...new Set(leads.map(l => l.p).filter(Boolean))].sort();
  pipeEl.innerHTML = '<option value="">All Segmentations</option>'
    + pipes.map(p => '<option value="' + esc(p) + '">' + esc(p) + '</option>').join('');

  const vendEl = document.getElementById('mkt-filter-vendor');
  const { data: profs } = await sb.from('profiles').select('name').eq('role', 'vendor').order('name');
  vendEl.innerHTML = '<option value="">All Vendors</option>'
    + (profs || []).map(p => '<option value="' + esc(p.name) + '">' + esc(p.name) + '</option>').join('');

  await loadMcAudiences();
  renderMktTagManager();
  await loadMcSettings();
  refreshMktPreview();
}

async function loadMcSettings() {
  const el = document.getElementById('mc-settings-wrap');
  if (!el) return;
  try {
    const data = await mcCall('get_settings');
    const lists = await mcCall('get_lists');
    const allLists = lists.lists || [];
    window._mcSettings = data;
    window._mcAllLists = allLists;
    renderMcSettings(data, allLists);
  } catch(e) {
    if (el) el.innerHTML = '<div style="color:var(--danger);font-size:12px">Could not load — check Edge Function deployment</div>';
  }
}

function renderMcSettings(settings, allLists) {
  const el = document.getElementById('mc-settings-wrap');
  if (!el) return;

  const listOptions = (selected) =>
    '<option value="">— None —</option>'
    + allLists.map(l =>
        '<option value="' + l.id + '"' + (l.id === selected ? ' selected' : '') + '>'
        + esc(l.name) + ' (' + l.stats.member_count + ')</option>'
      ).join('');

  let html = '<div style="display:flex;flex-direction:column;gap:16px">';

  // Main list
  html += '<div>'
    + '<div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.7px;margin-bottom:6px;font-weight:600">Main List — all leads with email</div>'
    + '<div style="display:flex;gap:8px;align-items:center">'
    + '<select class="form-select" style="flex:1" id="mc-main-list-sel" onchange="setMcMainList(this.value)">'
    + listOptions(settings.main_list_id)
    + '</select>'
    + (settings.main_list_id ? '<span style="font-size:11px;color:var(--accent)">✅ Active</span>' : '<span style="font-size:11px;color:var(--warn)">⚠️ Not set</span>')
    + '</div></div>';

  // Tag lists
  html += '<div>'
    + '<div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.7px;margin-bottom:8px;font-weight:600">Tag Lists — one per MKT Tag</div>'
    + '<div style="display:flex;flex-direction:column;gap:8px">'
    + mktTagTypes.map(tag => {
        const currentListId = settings.tag_lists?.[tag] || '';
        return '<div style="display:flex;gap:8px;align-items:center">'
          + '<div style="min-width:180px;font-size:12px;color:var(--text2)">' + esc(tag) + '</div>'
          + '<select class="form-select" style="flex:1" onchange="setMcTagList(\'' + esc(tag) + '\',this.value)">'
          + listOptions(currentListId)
          + '</select>'
          + (currentListId ? '<span style="font-size:11px;color:var(--accent)">✅</span>' : '<span style="font-size:11px;color:var(--text3)">—</span>')
          + '</div>';
      }).join('')
    + '</div></div>';

  html += '</div>';
  el.innerHTML = html;
}

async function setMcMainList(listId) {
  await mcCall('set_main_list', { listId });
  showToast(listId ? '✅ Main list set' : '🗑 Main list removed');
  await loadMcSettings();
}

async function setMcTagList(tag, listId) {
  await mcCall('set_tag_list', { tag, listId });
  showToast(listId ? '✅ List set for "' + tag + '"' : '🗑 List removed for "' + tag + '"');
  await loadMcSettings();
}
async function loadMcAudiences() {
  const sel = document.getElementById('mkt-audience-select');
  sel.innerHTML = '<option value="">Loading...</option>';
  try {
    const data = await mcCall('get_lists');
    if (data.lists && data.lists.length) {
      sel.innerHTML = '<option value="">— Select or create new —</option>'
        + data.lists.map(l => '<option value="' + l.id + '">' + esc(l.name) + ' (' + l.stats.member_count + ' members)</option>').join('');
    } else {
      sel.innerHTML = '<option value="">No lists yet — create one below</option>';
    }
  } catch(e) {
    sel.innerHTML = '<option value="">Could not load — check API key</option>';
  }
}

function getMktLeads() {
  const pipeline  = document.getElementById('mkt-filter-segmentation')?.value || '';
  const status    = document.getElementById('mkt-filter-status')?.value   || '';
  const vendor    = document.getElementById('mkt-filter-vendor')?.value   || '';
  const emailOnly = document.getElementById('mkt-filter-email')?.value    !== '';

  return leads.filter(l => {
    if (pipeline && l.p !== pipeline)                              return false;
    if (status   && l.cs !== status)                               return false;
    if (vendor   && (l.responsible || l.r) !== vendor)            return false;
    if (emailOnly && !l.em)                                        return false;
    return true;
  });
}

function mktSortBy(col) {
  if (mktSortCol === col) {
    mktSortDir *= -1;
  } else {
    mktSortCol = col;
    mktSortDir = 1;
  }
  refreshMktPreview();
}

let mktDisplayLeads = [];

async function refreshMktPreview() {
  // Always fetch fresh tags so all users see the latest
  await loadMktTagTypes();
  updateMktTagFilter();
  const pool = getMktLeads();
  const withEmail = pool.filter(l => l.em);

  // Stats
  document.getElementById('mkt-preview-stats').innerHTML =
    '<div class="kpi-card blue" style="padding:12px 20px;min-width:120px"><div class="kpi-card-val">' + pool.length.toLocaleString() + '</div><div class="kpi-card-lbl">Total Leads</div></div>'
    + '<div class="kpi-card teal" style="padding:12px 20px;min-width:120px"><div class="kpi-card-val">' + withEmail.length.toLocaleString() + '</div><div class="kpi-card-lbl">With Email</div></div>'
    + '<div class="kpi-card warn" style="padding:12px 20px;min-width:120px"><div class="kpi-card-val">' + (pool.length - withEmail.length).toLocaleString() + '</div><div class="kpi-card-lbl">No Email</div></div>';

  // Apply search
  let display = withEmail;
  if (mktSearch) {
    const s = mktSearch.toLowerCase();
    display = display.filter(l =>
      (l.c + ' ' + l.cn + ' ' + l.em + ' ' + (l.mkt_tag||'')).toLowerCase().includes(s)
    );
  }

  // Sort
  display = [...display].sort((a, b) => {
    let av = a[mktSortCol] || '', bv = b[mktSortCol] || '';
    if (mktSortCol === 'cc') { av = a.cc || 0; bv = b.cc || 0; return (av - bv) * mktSortDir; }
    return av.localeCompare(bv) * mktSortDir;
  });

  // Save for export — export uses exactly what's visible in the table
  mktDisplayLeads = display;

  // Update count label
  const countLabel = document.getElementById('mkt-count-label');
  if (countLabel) countLabel.textContent = display.length.toLocaleString() + ' leads';

  // Sort indicators
  const cols = ['c','cn','em','cs','p','responsible','mkt_tag'];
  const headers = document.querySelectorAll('#mkt-preview-table thead th[data-col]');
  headers.forEach(th => {
    const col = th.dataset.col;
    th.textContent = th.dataset.label + (mktSortCol === col ? (mktSortDir === 1 ? ' ↑' : ' ↓') : '');
  });

  // Table
  const tbody = document.getElementById('mkt-preview-tbody');
  if (!display.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:20px">No leads match this filter</td></tr>';
    return;
  }

  // Build tag dropdown options
  const buildTagOptions = (currentTag) => {
    return ['<option value="">— No tag —</option>']
      .concat(mktTagTypes.map(t =>
        '<option value="' + esc(t) + '"' + (t === (currentTag || '') ? ' selected' : '') + '>' + esc(t) + '</option>'
      )).join('');
  };

  tbody.innerHTML = display.map(l =>
    '<tr>'
    + '<td>' + esc(l.c || '—') + '</td>'
    + '<td>' + esc(l.cn || '—') + '</td>'
    + '<td style="color:var(--accent)">' + esc(l.em) + '</td>'
    + '<td><span style="font-size:10px;padding:2px 7px;border-radius:10px;background:var(--accent-dim);color:var(--accent)">' + esc(l.cs || '—') + '</span></td>'
    + '<td style="font-size:11px;color:var(--text3)">' + esc((l.p||'').split(' - ').pop()||'—') + '</td>'
    + '<td style="font-size:11px">' + esc(l.responsible || l.r || '—') + '</td>'
    + '<td>'
      + '<select class="mkt-tag-select" onchange="saveMktTag(' + l.id + ',this.value)">'
      + buildTagOptions(l.mkt_tag)
      + '</select>'
    + '</td>'
    + '</tr>'
  ).join('');
}

async function saveMktTag(leadId, tag) {
  const lead = leads.find(l => l.id === leadId);
  if (!lead) return;
  lead.mkt_tag = tag || '';
  await saveLeadState(lead);
  showToast(tag ? '🏷 Tag "' + tag + '" saved' : '🏷 Tag removed');
}

function mktSearchInput(val) {
  mktSearch = val;
  refreshMktPreview();
}

let mcExportCancelled = false;

function cancelMcExport() {
  mcExportCancelled = true;
  const cancelBtn = document.getElementById('mkt-cancel-btn');
  if (cancelBtn) cancelBtn.disabled = true;
  const progressLbl = document.getElementById('mkt-progress-label');
  if (progressLbl) progressLbl.textContent = '⏹ Cancelling...';
  showToast('⏹ Cancelling export...');
}

async function exportToMailchimp() {
  // Use exactly what's visible in the table (after search/filter)
  const pool = mktDisplayLeads.filter(l => l.em);
  if (!pool.length) { showToast('⚠️ No leads with email to export'); return; }

  const btn = document.getElementById('mkt-export-btn');
  const statusEl = document.getElementById('mkt-export-status');
  const progressWrap = document.getElementById('mkt-progress-wrap');
  const progressBar  = document.getElementById('mkt-progress-bar');
  const progressLbl  = document.getElementById('mkt-progress-label');

  let listId = document.getElementById('mkt-audience-select').value;
  const newName = document.getElementById('mkt-new-list-name').value.trim();
  const tag = document.getElementById('mkt-tag').value.trim();

  if (!listId && !newName) { showToast('⚠️ Select a list or enter a new list name'); return; }

  mcExportCancelled = false;
  btn.disabled = true;
  btn.textContent = '⏳ Exporting...';
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';
  progressBar.style.background = 'var(--accent)';

  // Show cancel button
  let cancelBtn = document.getElementById('mkt-cancel-btn');
  if (!cancelBtn) {
    cancelBtn = document.createElement('button');
    cancelBtn.id = 'mkt-cancel-btn';
    cancelBtn.className = 'btn btn-danger';
    cancelBtn.style.cssText = 'padding:8px 16px;font-size:12px';
    cancelBtn.textContent = '⏹ Cancel';
    cancelBtn.onclick = cancelMcExport;
    btn.parentNode.insertBefore(cancelBtn, btn.nextSibling);
  }
  cancelBtn.style.display = '';
  cancelBtn.disabled = false;

  try {
    // Create new list if needed
    if (!listId && newName) {
      statusEl.textContent = 'Creating list...';
      const data = await mcCall('create_list', { listName: newName });
      if (!data.id) throw new Error(data.title || data.detail || 'Failed to create list');
      listId = data.id;
      await loadMcAudiences();
      document.getElementById('mkt-audience-select').value = listId;
    }

    const CHUNK = 500;
    let done = 0, errors = 0;

    for (let i = 0; i < pool.length; i += CHUNK) {
      // Check cancellation before each chunk
      if (mcExportCancelled) {
        progressBar.style.background = 'var(--warn)';
        progressLbl.textContent = '⏹ Cancelled — ' + done + ' contacts exported before cancel';
        statusEl.textContent = done + ' added before cancel';
        showToast('⏹ Export cancelled — ' + done + ' contacts were sent');
        logActivity(null, null, 'field_edit', 'Mailchimp export CANCELLED: ' + done + ' contacts to list ' + listId);
        return;
      }

      const chunk = pool.slice(i, i + CHUNK);
      const members = chunk.map(l => ({
        email_address: (l.em || '').split(';')[0].toLowerCase().trim(),
        contact: l.cn || '',
        company: l.c  || ''
      })).filter(m => m.email_address && m.email_address.includes('@'));

      const data = await mcCall('batch_members', { listId, members, tag });
      done   += data.total_created || (data.new_members?.length || 0) + (data.updated_members?.length || 0);
      errors += data.error_count || 0;

      const pct = Math.min(100, Math.round(((i + chunk.length) / pool.length) * 100));
      progressBar.style.width = pct + '%';
      progressLbl.textContent = 'Exporting... ' + pct + '% (' + (i + chunk.length) + '/' + pool.length + ')';
      statusEl.textContent = done + ' added, ' + errors + ' errors';
    }

    progressBar.style.width = '100%';
    progressLbl.textContent = '✅ Done!';
    statusEl.textContent = done + ' contacts exported, ' + errors + ' errors';
    showToast('✅ ' + done + ' contacts sent to Mailchimp!');
    logActivity(null, null, 'field_edit', 'Mailchimp export: ' + done + ' contacts to list ' + listId);

  } catch(err) {
    if (!mcExportCancelled) {
      statusEl.textContent = '❌ ' + err.message;
      showToast('❌ Export failed: ' + err.message);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '📤 Export to Mailchimp';
    if (cancelBtn) cancelBtn.style.display = 'none';
    mcExportCancelled = false;
  }
}

// ── TABS / TOAST ──────────────────────────────────────────────
function switchTab(tab, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');

  document.getElementById('tab-leads').style.display     = tab === 'leads'     ? 'block' : 'none';
  document.getElementById('tab-dashboard').style.display = tab === 'dashboard' ? 'block' : 'none';
  document.getElementById('tab-analytics').style.display = tab === 'analytics' ? 'block' : 'none';
  document.getElementById('tab-sales').style.display     = tab === 'sales'     ? 'block' : 'none';

  if (tab === 'analytics' && !analyticsDateFrom) {
    const btn = document.querySelector('.preset-btn[onclick*="30d"]');
    if (btn) setPreset('30d', btn);
  } else if (tab === 'analytics') {
    loadAnalytics();
  }
}
function showToast(msg) {
  const t = document.createElement('div');
  t.className   = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── NEW LEAD ──────────────────────────────────────────────────
function openNewLeadModal() {
  document.getElementById('modal-company').textContent = 'New Lead';
  document.getElementById('modal-sub').textContent = 'Fill in the details below';
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-section">
      <div class="modal-section-title">📝 Lead Information</div>
      <div class="info-grid">
        ${newLeadField('Company',   'nl-company',  'text',  true)}
        ${newLeadField('Contact',   'nl-contact',  'text')}
        ${newLeadField('Email',     'nl-email',    'email')}
        ${newLeadField('Phone',     'nl-phone',    'tel')}
        ${newLeadField('Type',      'nl-type',     'text',  false, 'Florist, Event Planner...')}
        ${newLeadField('State',     'nl-state',    'text',  false, 'e.g. Florida')}
      </div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">📋 Notes</div>
      <textarea class="modal-textarea" id="nl-notes" placeholder="Initial notes..."></textarea>
    </div>`;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saveNewLead()">➕ Create Lead</button>`;
  document.getElementById('modal').style.display = 'flex';
}

function newLeadField(label, id, type, required, placeholder) {
  return `<div class="info-item">
    <div class="info-item-lbl">${label}${required ? ' <span style="color:var(--danger)">*</span>' : ''}</div>
    <div class="info-item-val">
      <input type="${type}" id="${id}" class="edit-field" placeholder="${placeholder || label + '...'}">
    </div>
  </div>`;
}

async function saveNewLead() {
  const company = document.getElementById('nl-company')?.value.trim();
  if (!company) { showToast('⚠️ Company name is required'); return; }

  const notes   = document.getElementById('nl-notes')?.value.trim();
  const contact = document.getElementById('nl-contact')?.value.trim();
  const email   = document.getElementById('nl-email')?.value.trim();
  const phone   = document.getElementById('nl-phone')?.value.trim();
  const type    = document.getElementById('nl-type')?.value.trim();
  const state   = document.getElementById('nl-state')?.value.trim();

  const maxId = leads.length ? Math.max(...leads.map(l => l.id || 0)) : 0;
  const newId = maxId + 1;

  const { error } = await sb.from('leads').insert({
    id:          newId,
    company:     company,
    contact:     contact  || null,
    email:       email    || null,
    phone:       phone    || null,
    type:        type     || null,
    state:       state    || null,
    responsible: currentProfile?.name || null,
    pipeline:    'New Lead'
  });
  if (error) { showToast('❌ Error: ' + error.message); return; }

  await sb.from('lead_states').insert({
    lead_id:     newId,
    responsible: currentProfile?.name || null,
    cs:          'novo',
    notes:       notes || '',
    tags:        [],
    priority:    false,
    call_count:  0,
    timeline:    [],
    updated_by:  currentUser?.id,
    updated_at:  new Date().toISOString()
  });

  const newLead = {
    id: newId, c: company, p: 'New Lead',
    r: currentProfile?.name || '', st: state || '',
    ty: type || '', cn: contact || '', em: email || '',
    ph: phone || '', sl: null, cs: 'novo', tg: [], pr: false,
    cc: 0, lc: null, cv: false, cm: notes || '', tl: [],
    responsible: currentProfile?.name || '',
    mkt_tag: ''
  };
  leads.push(newLead);

  logActivity(newId, company, 'lead_created', 'New lead created by ' + (currentProfile?.name || '?'));
  closeModal();
  applyFilters();
  showToast('✅ Lead created: ' + company);
}

// ── DELETE USER ────────────────────────────────────────────────
async function deleteUser(userId, userName) {
  if (currentUser?.id === userId) {
    showToast('❌ You cannot delete your own account');
    return;
  }
  if (!confirm('Delete user "' + userName + '"?\n\nThis will remove their access. Their leads will remain assigned to them.')) return;

  const { error } = await sb.from('profiles').delete().eq('id', userId);
  if (error) { showToast('❌ Error: ' + error.message); return; }

  showToast('✅ "' + userName + '" removed from CRM');
  logActivity(null, null, 'field_edit', 'Removed user: ' + userName);
  await loadAdminData();
}

// ── DELETE LEAD ────────────────────────────────────────────────
async function deleteLead(id) {
  if (currentProfile?.role !== 'admin') return;
  const lead = leads.find(l => l.id === id);
  if (!lead) return;
  if (!confirm('Delete lead "' + lead.c + '"?\n\nThis cannot be undone.')) return;

  await sb.from('lead_states').delete().eq('lead_id', id);
  await sb.from('activity_log').delete().eq('lead_id', id);

  const { error } = await sb.from('leads').delete().eq('id', id);
  if (error) { showToast('❌ Error: ' + error.message); return; }

  const idx = leads.findIndex(l => l.id === id);
  if (idx !== -1) leads.splice(idx, 1);

  logActivity(null, lead.c, 'lead_deleted', 'Lead deleted by admin');
  // Archive in Mailchimp if has email
  if (lead.em) {
    try {
      const { data: { session } } = await sb.auth.getSession();
      fetch(MC_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify({ action: 'archive_contact', email: lead.em })
      });
    } catch(e) { /* silent */ }
  }
  closeModal();
  applyFilters();
  showToast('🗑 Lead "' + lead.c.substring(0, 30) + '" deleted');
}

// ── BULK CSV IMPORT ───────────────────────────────────────────
let bulkPreviewData = [];

function bulkImportFileChange(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result;
    parseBulkCSV(text);
  };
  reader.readAsText(file);
}

function parseBulkCSV(text) {
  // Normalize line endings
  const lines = text.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) { showToast('⚠️ CSV is empty'); return; }

  // Auto-detect separator: semicolon or comma
  const sep = lines[0].includes(';') ? ';' : ',';

  const parseRow = (line, separator) => {
    const cols = [];
    let inQuote = false, cur = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === separator && !inQuote) { cols.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    cols.push(cur.trim());
    return cols;
  };

  // Parse header using same parseRow to handle quoted headers
  const rawHeaders = parseRow(lines[0], sep);
  const headers = rawHeaders.map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());

  const idx = name => headers.findIndex(h => h === name);
  const colMap = {
    id:       idx('id'),
    company:  idx('company'),
    contact:  idx('contact'),
    email:    idx('email'),
    phone:    idx('phone'),
    owner:    idx('owner'),
    pipeline: headers.findIndex(h => h === 'pipeline' || h === 'segmentation'),
    type:     idx('type'),
    status:   idx('status'),
    tags:     idx('tags'),
    mkt_tag:  headers.findIndex(h => h === 'mkt tag' || h === 'mkt_tag'),
  };

  const statusMap = {
    'new': 'novo', 'contacted': 'contatado', 'proposal': 'proposta', 'customer': 'cliente',
    'novo': 'novo', 'contatado': 'contatado', 'proposta': 'proposta', 'cliente': 'cliente'
  };

  bulkPreviewData = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseRow(lines[i], sep);
    const get = colIdx => {
      if (colIdx < 0 || colIdx >= cols.length) return null;
      const v = cols[colIdx].replace(/^"|"$/g, '').trim();
      return v === '' ? null : v;
    };

    const csvId      = get(colMap.id);
    const csvCompany = get(colMap.company);

    if (!csvId && !csvCompany) continue;

    let lead = null;
    if (csvId) lead = leads.find(l => String(l.id) === String(csvId));
    if (!lead && csvCompany) lead = leads.find(l => l.c.toLowerCase() === csvCompany.toLowerCase());
    if (!lead) {
      bulkPreviewData.push({ error: `Not found: "${csvId || csvCompany}"`, row: i });
      continue;
    }

    const changes = {};
    const display = [];

    const check = (field, csvVal, currentVal, label) => {
      if (csvVal === null || csvVal === undefined) return;
      const cur = String(currentVal || '');
      const csv = String(csvVal);
      if (csv === cur) return;
      changes[field] = csvVal;
      display.push({ label, from: cur || '—', to: csv });
    };

    check('c',           get(colMap.company),  lead.c,                     'Company');
    check('cn',          get(colMap.contact),  lead.cn,                    'Contact');
    check('em',          get(colMap.email),    lead.em,                    'Email');
    check('ph',          get(colMap.phone),    lead.ph,                    'Phone');
    check('responsible', get(colMap.owner),    lead.responsible || lead.r, 'Owner');
    check('p',           get(colMap.pipeline), lead.p,                     'Segmentation');
    check('ty',          get(colMap.type),     lead.ty,                    'Type');

    const csvStatus = get(colMap.status);
    if (csvStatus) {
      const mapped = statusMap[csvStatus.toLowerCase()];
      if (mapped && mapped !== lead.cs) {
        changes['cs'] = mapped;
        display.push({ label: 'Status', from: lead.cs, to: mapped });
      }
    }

    const csvTags = get(colMap.tags);
    if (csvTags !== null) {
      const newTags = csvTags.split(';').map(t => t.trim()).filter(Boolean);
      const currentTagsStr = (lead.tg || []).join('; ');
      if (csvTags !== currentTagsStr) {
        changes['tg'] = newTags;
        display.push({ label: 'Tags', from: currentTagsStr || '—', to: csvTags });
      }
    }

    const csvMktTag = get(colMap.mkt_tag);
    if (csvMktTag !== null && csvMktTag !== (lead.mkt_tag || '')) {
      changes['mkt_tag'] = csvMktTag;
      display.push({ label: 'MKT Tag', from: lead.mkt_tag || '—', to: csvMktTag });
    }

    if (display.length > 0) {
      bulkPreviewData.push({ lead, changes, display });
    }
  }

  renderBulkPreview();
}

function renderBulkPreview() {
  const el = document.getElementById('bulk-preview-wrap');
  if (!el) return;

  const errors  = bulkPreviewData.filter(r => r.error);
  const changes = bulkPreviewData.filter(r => !r.error);

  if (bulkPreviewData.length === 0) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:12px 0">No changes detected in CSV.</div>';
    return;
  }

  let html = '';

  if (changes.length > 0) {
    html += '<div style="font-size:12px;color:var(--accent);font-weight:600;margin-bottom:8px">✅ ' + changes.length + ' lead' + (changes.length > 1 ? 's' : '') + ' will be updated:</div>';
    html += '<div style="overflow-x:auto;max-height:400px;overflow-y:auto;border:1px solid var(--border2);border-radius:8px">';
    html += '<table class="users-table"><thead><tr><th>Lead</th><th>Field</th><th>From</th><th>To</th></tr></thead><tbody>';
    changes.forEach(r => {
      r.display.forEach((d, i) => {
        html += '<tr>'
          + '<td style="font-weight:500">' + (i === 0 ? esc(r.lead.c) : '') + '</td>'
          + '<td style="color:var(--text3)">' + esc(d.label) + '</td>'
          + '<td style="color:var(--danger);font-size:11px">' + esc(d.from) + '</td>'
          + '<td style="color:var(--accent);font-size:11px">' + esc(d.to) + '</td>'
          + '</tr>';
      });
    });
    html += '</tbody></table></div>';
  }

  if (errors.length > 0) {
    html += '<div style="font-size:12px;color:var(--warn);font-weight:600;margin:12px 0 6px">⚠️ ' + errors.length + ' row' + (errors.length > 1 ? 's' : '') + ' not matched:</div>';
    html += errors.map(e => '<div style="font-size:11px;color:var(--text3);padding:2px 0">' + esc(e.error) + '</div>').join('');
  }

  if (changes.length > 0) {
    html += '<div style="margin-top:14px;display:flex;gap:10px">'
      + '<button class="btn btn-primary" onclick="applyBulkImport()" style="padding:8px 20px">✅ Apply ' + changes.length + ' Changes</button>'
      + '<button class="btn btn-ghost" onclick="cancelBulkImport()">Cancel</button>'
      + '</div>';
  }

  el.innerHTML = html;
}

async function applyBulkImport() {
  const changes = bulkPreviewData.filter(r => !r.error);
  if (!changes.length) return;

  const btn = document.querySelector('[onclick="applyBulkImport()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Applying...'; }

  let done = 0, errors = 0;

  for (const r of changes) {
    try {
      const lead = r.lead;
      const c = r.changes;

      // Update leads table fields
      const leadsUpdate = {};
      if (c.c)           leadsUpdate.company     = c.c;
      if (c.cn)          leadsUpdate.contact     = c.cn;
      if (c.em)          leadsUpdate.email       = c.em;
      if (c.ph)          leadsUpdate.phone       = c.ph;
      if (c.responsible) leadsUpdate.responsible = c.responsible;
      if (c.p)           leadsUpdate.pipeline    = c.p;
      if (c.ty)          leadsUpdate.type        = c.ty;

      if (Object.keys(leadsUpdate).length > 0) {
        await sb.from('leads').update(leadsUpdate).eq('id', lead.id);
      }

      // Apply changes to local lead object
      Object.assign(lead, c);

      // Save lead_states (status, tags, mkt_tag, responsible)
      await saveLeadState(lead);

      done++;
    } catch(e) {
      errors++;
      console.error('Bulk import error:', e);
    }
  }

  // Refresh display
  applyFilters();
  bulkPreviewData = [];

  const el = document.getElementById('bulk-preview-wrap');
  if (el) el.innerHTML = '<div style="color:var(--accent);font-size:13px;padding:12px 0">✅ ' + done + ' leads updated' + (errors ? ', ' + errors + ' errors' : '') + '.</div>';

  const fileInput = document.getElementById('bulk-csv-input');
  if (fileInput) fileInput.value = '';

  logActivity(null, null, 'field_edit', 'Bulk CSV import: ' + done + ' leads updated');
  showToast('✅ ' + done + ' leads updated!');
}

function cancelBulkImport() {
  bulkPreviewData = [];
  const el = document.getElementById('bulk-preview-wrap');
  if (el) el.innerHTML = '';
  const fileInput = document.getElementById('bulk-csv-input');
  if (fileInput) fileInput.value = '';
}

// ── SEGMENTATIONS ─────────────────────────────────────────────
let segmentations = [];

async function loadSegmentations() {
  const { data } = await sb.from('app_settings')
    .select('value').eq('key', 'segmentations').single();
  try {
    segmentations = data?.value ? JSON.parse(data.value) : [];
  } catch(e) { segmentations = []; }
  // Also sync from actual lead pipelines if empty
  if (!segmentations.length) {
    segmentations = [...new Set(leads.map(l => l.p).filter(Boolean))].sort();
    await saveSegmentations();
  }
}

async function saveSegmentations() {
  await sb.from('app_settings').upsert(
    { key: 'segmentations', value: JSON.stringify(segmentations) },
    { onConflict: 'key' }
  );
}

function renderSegmentationList() {
  const el = document.getElementById('segmentation-list');
  if (!el) return;
  if (!segmentations.length) {
    el.innerHTML = '<span style="color:var(--text3);font-size:12px">No segmentations yet.</span>';
    return;
  }
  el.innerHTML = segmentations.map((s, i) =>
    '<span style="display:inline-flex;align-items:center;gap:4px;background:var(--accent-dim);color:var(--accent);border:1px solid rgba(74,222,128,.25);border-radius:20px;padding:3px 12px;font-size:12px">'
    + esc(s)
    + '<button onclick="removeSegmentation(' + i + ')" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;line-height:1;padding:0 0 0 6px" title="Remove">×</button>'
    + '</span>'
  ).join('');
}

async function addSegmentation() {
  const inp = document.getElementById('new-segmentation');
  const val = inp.value.trim();
  if (!val) return;
  if (segmentations.includes(val)) { showToast('⚠️ Already exists'); return; }
  segmentations.push(val);
  segmentations.sort();
  inp.value = '';
  await saveSegmentations();
  renderSegmentationList();
  // Refresh sidebar filter
  populateSegmentationFilter();
  showToast('✅ Segmentation "' + val + '" added');
  logActivity(null, null, 'field_edit', 'Added segmentation: ' + val);
}

async function removeSegmentation(i) {
  const removed = segmentations.splice(i, 1)[0];
  await saveSegmentations();
  renderSegmentationList();
  populateSegmentationFilter();
  showToast('🗑 "' + removed + '" removed');
}

function populateSegmentationFilter() {
  const pSel = document.getElementById('filter-segmentation');
  if (!pSel) return;
  const current = pSel.value;
  pSel.innerHTML = '<option value="">All</option>'
    + segmentations.map(s => '<option value="' + esc(s) + '"' + (s === current ? ' selected' : '') + '>' + esc(s) + '</option>').join('');
}

// ── PERMISSIONS ───────────────────────────────────────────────
// ── PERMISSIONS ───────────────────────────────────────────────
const ALL_PERMISSIONS = [
  // Leads
  { key: 'view_all_leads',    label: 'View All Leads',      group: '👥 Leads',    desc: 'See leads from all vendors, not just own' },
  { key: 'edit_any_lead',     label: 'Edit Any Lead',       group: '👥 Leads',    desc: 'Edit fields on leads assigned to others' },
  { key: 'edit_segmentation', label: 'Edit Segmentation',   group: '👥 Leads',    desc: 'Change segmentation of leads' },
  { key: 'edit_mkt_tag',      label: 'Edit MKT Tag',        group: '👥 Leads',    desc: 'Change MKT tag of leads' },
  { key: 'reassign_leads',    label: 'Reassign Leads',      group: '👥 Leads',    desc: 'Change owner/responsible of leads' },
  { key: 'create_leads',      label: 'Create Leads',        group: '👥 Leads',    desc: 'Create new leads' },
  { key: 'delete_leads',      label: 'Delete Leads',        group: '👥 Leads',    desc: 'Delete leads permanently' },
  // Data
  { key: 'export_csv',        label: 'Export CSV',          group: '📊 Data',     desc: 'Download leads as CSV' },
  { key: 'bulk_import',       label: 'Bulk Import',         group: '📊 Data',     desc: 'Update leads via CSV upload' },
  { key: 'create_quotes',     label: 'Create Quotes',       group: '📊 Data',     desc: 'Create and download quotes' },
  // Panels
  { key: 'view_analytics',    label: 'View Analytics',      group: '🖥 Panels',   desc: 'Access analytics tab' },
  { key: 'view_mkt',          label: 'Access MKT Panel',    group: '🖥 Panels',   desc: 'Access email marketing panel' },
  { key: 'export_mailchimp',  label: 'Export to Mailchimp', group: '🖥 Panels',   desc: 'Export contacts to Mailchimp' },
];

// Default permissions per role
const ROLE_DEFAULTS = {
  admin: Object.fromEntries(ALL_PERMISSIONS.map(p => [p.key, true])),
  mkt: {
    view_all_leads:    true,
    edit_any_lead:     true,
    edit_segmentation: true,
    edit_mkt_tag:      true,
    reassign_leads:    false,
    create_leads:      false,
    delete_leads:      false,
    export_csv:        true,
    bulk_import:       false,
    create_quotes:     false,
    view_analytics:    false,
    view_mkt:          true,
    export_mailchimp:  true,
  },
  vendor: {
    view_all_leads:    false,
    edit_any_lead:     false,
    edit_segmentation: false,
    edit_mkt_tag:      false,
    reassign_leads:    false,
    create_leads:      true,
    delete_leads:      false,
    export_csv:        false,
    bulk_import:       false,
    create_quotes:     true,
    view_analytics:    false,
    view_mkt:          false,
    export_mailchimp:  false,
  }
};

function hasPermission(key) {
  if (currentProfile?.role === 'admin') return true;
  const perms = currentProfile?.permissions || {};
  // If explicitly set, use that value
  if (perms[key] !== undefined) return perms[key] === true;
  // Otherwise fall back to role default
  return ROLE_DEFAULTS[currentProfile?.role]?.[key] === true;
}

function getEffectivePermissions(user) {
  const roleDefaults = ROLE_DEFAULTS[user.role] || ROLE_DEFAULTS.vendor;
  const userPerms = user.permissions || {};
  const result = {};
  ALL_PERMISSIONS.forEach(p => {
    result[p.key] = userPerms[p.key] !== undefined ? userPerms[p.key] : roleDefaults[p.key];
  });
  return result;
}

function renderPermissionsTable() {
  const tbody = document.getElementById('permissions-tbody');
  if (!tbody) return;
  const nonAdmins = allUsers.filter(u => u.role !== 'admin');
  if (!nonAdmins.length) {
    tbody.innerHTML = '<tr><td colspan="2" style="color:var(--text3);text-align:center;padding:20px">No non-admin users found</td></tr>';
    return;
  }

  tbody.innerHTML = nonAdmins.map(u => {
    const effective = getEffectivePermissions(u);
    const groups = [...new Set(ALL_PERMISSIONS.map(p => p.group))];

    const groupsHtml = groups.map(group => {
      const permsInGroup = ALL_PERMISSIONS.filter(p => p.group === group);
      return '<div style="margin-bottom:14px">'
        + '<div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px">' + group + '</div>'
        + '<div style="display:flex;flex-wrap:wrap;gap:8px">'
        + permsInGroup.map(p => {
            const checked = effective[p.key];
            const isDefault = (u.permissions || {})[p.key] === undefined;
            return '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:5px 10px;border-radius:8px;border:1px solid ' + (checked ? 'rgba(74,222,128,.3)' : 'var(--border2)') + ';background:' + (checked ? 'var(--accent-dim)' : 'var(--bg)') + ';font-size:11px;color:' + (checked ? 'var(--accent)' : 'var(--text3)') + ';min-width:160px" title="' + esc(p.desc) + (isDefault ? ' (role default)' : ' (custom)') + '">'
              + '<span class="perm-toggle" style="flex-shrink:0">'
              + '<input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="togglePermission(\'' + u.id + '\',\'' + p.key + '\',this.checked)">'
              + '<span class="perm-toggle-slider"></span>'
              + '</span>'
              + esc(p.label)
              + (isDefault ? '' : '<span style="font-size:9px;opacity:.6;margin-left:2px">✎</span>')
              + '</label>';
          }).join('')
        + '</div></div>';
    }).join('');

    return '<tr>'
      + '<td style="vertical-align:top;padding:16px 12px;border-bottom:2px solid var(--border);min-width:140px">'
      + '<div style="font-weight:700;font-size:13px">' + esc(u.name) + '</div>'
      + '<div style="font-size:11px;color:var(--text3);margin-top:3px">' + u.role + '</div>'
      + '<button onclick="resetToRoleDefaults(\'' + u.id + '\')" style="margin-top:8px;background:none;border:1px solid var(--border2);color:var(--text3);border-radius:6px;padding:3px 8px;font-size:10px;cursor:pointer" title="Reset to role defaults">↺ Reset</button>'
      + '</td>'
      + '<td style="padding:16px 12px;border-bottom:2px solid var(--border)">' + groupsHtml + '</td>'
      + '</tr>';
  }).join('');
}

async function togglePermission(userId, permKey, value) {
  const user = allUsers.find(u => u.id === userId);
  if (!user) return;
  if (!user.permissions) user.permissions = {};
  user.permissions[permKey] = value;
  const { error } = await sb.from('profiles').update({ permissions: user.permissions }).eq('id', userId);
  if (error) { showToast('❌ Error: ' + error.message); return; }
  renderPermissionsTable();
  showToast('✅ ' + user.name + ' — ' + permKey + ' → ' + (value ? 'ON' : 'OFF'));
  logActivity(null, null, 'field_edit', 'Permission ' + permKey + ' = ' + value + ' for ' + user.name);
}

async function resetToRoleDefaults(userId) {
  const user = allUsers.find(u => u.id === userId);
  if (!user) return;
  if (!confirm('Reset all permissions for ' + user.name + ' to role defaults?')) return;
  user.permissions = {};
  const { error } = await sb.from('profiles').update({ permissions: {} }).eq('id', userId);
  if (error) { showToast('❌ Error: ' + error.message); return; }
  renderPermissionsTable();
  showToast('↺ Reset to defaults for ' + user.name);
}

// ── QUOTES ────────────────────────────────────────────────────
let currentQuote = null;
let quoteItems = [];

function openQuoteModal(leadId) {
  const lead = leads.find(l => l.id === leadId);
  if (!lead) return;
  currentQuote = { lead_id: leadId, status: 'draft', items: [], discount: 0, total: 0, notes: '', valid_until: '' };
  quoteItems = [];
  renderQuoteModal(lead);
  document.getElementById('quote-modal').style.display = 'flex';
}

function closeQuoteModal() {
  document.getElementById('quote-modal').style.display = 'none';
  currentQuote = null;
  quoteItems = [];
}

async function loadLeadQuotes(leadId) {
  const el = document.getElementById('modal-quotes-list');
  if (!el) return;

  const { data, error } = await sb.from('quotes')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false });

  if (error || !data || !data.length) {
    el.innerHTML = '<span style="font-size:12px;color:var(--text3)">No quotes yet.</span>';
    return;
  }

  const statusColors = { draft:'var(--text3)', sent:'var(--info)', approved:'var(--accent)', declined:'var(--danger)' };
  const statusEmoji  = { draft:'📝', sent:'📤', approved:'✅', declined:'❌' };

  el.innerHTML = data.map(q => {
    const date = new Date(q.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    const color = statusColors[q.status] || 'var(--text3)';
    const emoji = statusEmoji[q.status] || '📄';
    return '<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-bottom:6px">'
      + '<div style="flex:1">'
      + '<div style="font-size:12px;font-weight:600;color:var(--text)">' + emoji + ' $' + parseFloat(q.total || 0).toFixed(2)
      + ' <span style="font-size:10px;color:' + color + ';font-weight:500;text-transform:uppercase">' + q.status + '</span></div>'
      + '<div style="font-size:10px;color:var(--text3);margin-top:2px">' + date + ' · ' + esc(q.created_by_name || '—')
      + (q.valid_until ? ' · Valid until: ' + new Date(q.valid_until).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '')
      + '</div>'
      + '</div>'
      + '<div style="display:flex;gap:6px">'
      + '<button class="btn btn-ghost" style="padding:4px 10px;font-size:11px" onclick="downloadExistingQuote(\'' + q.id + '\')">📥 PDF</button>'
      + '<button class="btn btn-ghost" style="padding:4px 10px;font-size:11px" onclick="changeQuoteStatus(\'' + q.id + '\',\'' + leadId + '\')">✏️ Status</button>'
      + '</div>'
      + '</div>';
  }).join('');
}

async function downloadExistingQuote(quoteId) {
  const { data: q } = await sb.from('quotes').select('*').eq('id', quoteId).single();
  if (!q) { showToast('❌ Quote not found'); return; }
  const lead = leads.find(l => l.id === q.lead_id);
  generateQuotePDF(q, lead);
}

async function changeQuoteStatus(quoteId, leadId) {
  const statuses = ['draft', 'sent', 'approved', 'declined'];
  const { data: q } = await sb.from('quotes').select('status').eq('id', quoteId).single();
  if (!q) return;

  const currentIdx = statuses.indexOf(q.status);
  const options = statuses.map((s, i) =>
    '<button class="btn ' + (i === currentIdx ? 'btn-primary' : 'btn-ghost') + '" style="font-size:11px;padding:5px 12px" onclick="setQuoteStatus(\'' + quoteId + '\',\'' + s + '\',\'' + leadId + '\')">'
    + { draft:'📝 Draft', sent:'📤 Sent', approved:'✅ Approved', declined:'❌ Declined' }[s]
    + '</button>'
  ).join('');

  // Show inline status picker
  const el = document.getElementById('modal-quotes-list');
  const picker = document.createElement('div');
  picker.id = 'quote-status-picker-' + quoteId;
  picker.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;padding:8px;background:var(--surface2);border-radius:8px;margin-bottom:8px';
  picker.innerHTML = options;
  el.prepend(picker);
}

async function setQuoteStatus(quoteId, newStatus, leadId) {
  await sb.from('quotes').update({ status: newStatus }).eq('id', quoteId);
  showToast('✅ Status → ' + newStatus);
  // Remove picker and reload
  const picker = document.getElementById('quote-status-picker-' + quoteId);
  if (picker) picker.remove();
  loadLeadQuotes(leadId);
}

function renderQuoteModal(lead) {
  document.getElementById('quote-modal-title').textContent = '📄 New Quote';
  document.getElementById('quote-modal-sub').textContent = lead.c + (lead.cn ? ' · ' + lead.cn : '');

  const today = new Date();
  const validDefault = new Date(today.setDate(today.getDate() + 30)).toISOString().split('T')[0];

  document.getElementById('quote-modal-body').innerHTML = `
    <div class="modal-section">
      <div class="modal-section-title">📋 Quote Details</div>
      <div class="info-grid">
        <div class="info-item">
          <div class="info-item-lbl">Valid Until</div>
          <div class="info-item-val"><input type="date" class="edit-field" id="q-valid" value="${validDefault}"></div>
        </div>
        <div class="info-item">
          <div class="info-item-lbl">Status</div>
          <div class="info-item-val">
            <select class="edit-field edit-select" id="q-status">
              <option value="draft">Draft</option>
              <option value="sent">Sent</option>
              <option value="approved">Approved</option>
              <option value="declined">Declined</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">🌸 Products / Items</div>
      <div id="quote-items-wrap"></div>
      <button class="btn btn-ghost" onclick="addQuoteItem()" style="margin-top:8px;font-size:12px">+ Add Item</button>
    </div>

    <div class="modal-section">
      <div style="display:flex;justify-content:flex-end;gap:16px;align-items:center;flex-wrap:wrap">
        <div style="font-size:13px;color:var(--text2)">
          Discount: <input type="number" id="q-discount" value="0" min="0" max="100" step="0.1"
            style="width:70px;background:var(--bg);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:4px 8px;font-size:13px"
            oninput="updateQuoteTotals()"> %
        </div>
        <div style="font-size:16px;font-weight:700;color:var(--accent)">Total: <span id="q-total">$0.00</span></div>
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">📝 Notes</div>
      <textarea class="modal-textarea" id="q-notes" placeholder="Additional notes, terms, delivery info..."></textarea>
    </div>
  `;

  renderQuoteItems();

  document.getElementById('quote-modal-footer').innerHTML = `
    <button class="btn btn-ghost" onclick="closeQuoteModal()">Cancel</button>
    <button class="btn btn-ghost" onclick="saveAndDownloadQuote()" style="color:var(--info);border-color:var(--info)">📥 Save & Download PDF</button>
    <button class="btn btn-primary" onclick="saveQuote()">💾 Save Quote</button>
  `;
}

function addQuoteItem() {
  quoteItems.push({ name: '', qty: 1, unit: 'unit', price: 0, subtotal: 0 });
  renderQuoteItems();
}

function removeQuoteItem(i) {
  quoteItems.splice(i, 1);
  renderQuoteItems();
  updateQuoteTotals();
}

function updateQuoteItem(i, field, val) {
  quoteItems[i][field] = field === 'qty' || field === 'price' ? parseFloat(val) || 0 : val;
  quoteItems[i].subtotal = (quoteItems[i].qty || 0) * (quoteItems[i].price || 0);
  updateQuoteTotals();
  // Update subtotal display without re-rendering
  const sub = document.getElementById('q-sub-' + i);
  if (sub) sub.textContent = '$' + quoteItems[i].subtotal.toFixed(2);
}

function renderQuoteItems() {
  const wrap = document.getElementById('quote-items-wrap');
  if (!wrap) return;
  if (!quoteItems.length) {
    wrap.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px 0">No items yet — click "+ Add Item"</div>';
    return;
  }
  wrap.innerHTML = `
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr style="border-bottom:1px solid var(--border2)">
          <th style="padding:6px 8px;text-align:left;color:var(--text3);font-size:10px;text-transform:uppercase">Product / Description</th>
          <th style="padding:6px 8px;text-align:center;color:var(--text3);font-size:10px;text-transform:uppercase;width:70px">Qty</th>
          <th style="padding:6px 8px;text-align:center;color:var(--text3);font-size:10px;text-transform:uppercase;width:80px">Unit</th>
          <th style="padding:6px 8px;text-align:right;color:var(--text3);font-size:10px;text-transform:uppercase;width:100px">Unit Price</th>
          <th style="padding:6px 8px;text-align:right;color:var(--text3);font-size:10px;text-transform:uppercase;width:100px">Subtotal</th>
          <th style="width:32px"></th>
        </tr>
      </thead>
      <tbody>
        ${quoteItems.map((item, i) => `
          <tr style="border-bottom:1px solid var(--border2)">
            <td style="padding:5px 8px">
              <input type="text" class="edit-field" value="${esc(item.name)}" placeholder="Product name..."
                oninput="updateQuoteItem(${i},'name',this.value)" style="min-width:180px">
            </td>
            <td style="padding:5px 8px;text-align:center">
              <input type="number" class="edit-field" value="${item.qty}" min="0" step="0.01"
                oninput="updateQuoteItem(${i},'qty',this.value)" style="width:60px;text-align:center">
            </td>
            <td style="padding:5px 8px;text-align:center">
              <select class="edit-field edit-select" onchange="updateQuoteItem(${i},'unit',this.value)" style="width:70px">
                ${['unit','bunch','box','stem','dozen','lb','kg'].map(u => `<option value="${u}" ${item.unit===u?'selected':''}>${u}</option>`).join('')}
              </select>
            </td>
            <td style="padding:5px 8px;text-align:right">
              <input type="number" class="edit-field" value="${item.price}" min="0" step="0.01"
                oninput="updateQuoteItem(${i},'price',this.value)" style="width:90px;text-align:right">
            </td>
            <td style="padding:5px 8px;text-align:right;color:var(--accent);font-weight:600" id="q-sub-${i}">
              $${item.subtotal.toFixed(2)}
            </td>
            <td style="padding:5px 4px;text-align:center">
              <button onclick="removeQuoteItem(${i})" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:2px">×</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>
  `;
}

function updateQuoteTotals() {
  const subtotal = quoteItems.reduce((s, i) => s + (i.subtotal || 0), 0);
  const discount = parseFloat(document.getElementById('q-discount')?.value) || 0;
  const total = subtotal * (1 - discount / 100);
  const el = document.getElementById('q-total');
  if (el) el.textContent = '$' + total.toFixed(2);
  return { subtotal, discount, total };
}

async function saveQuote() {
  if (!currentQuote) return;
  const { subtotal, discount, total } = updateQuoteTotals();
  const lead = leads.find(l => l.id === currentQuote.lead_id);

  const quoteData = {
    lead_id:        currentQuote.lead_id,
    created_by:     currentUser.id,
    created_by_name: currentProfile.name,
    status:         document.getElementById('q-status').value,
    valid_until:    document.getElementById('q-valid').value || null,
    notes:          document.getElementById('q-notes').value,
    discount,
    items:          quoteItems,
    total
  };

  const { data, error } = await sb.from('quotes').insert(quoteData).select().single();
  if (error) { showToast('❌ Error: ' + error.message); return; }

  // Add to lead timeline
  if (lead) {
    if (!lead.tl) lead.tl = [];
    lead.tl.push({
      ts: new Date().toISOString(),
      v: currentProfile.name,
      txt: '📄 Quote created — $' + total.toFixed(2) + ' (' + quoteData.status + ')'
    });
    await saveLeadState(lead);
  }

  logActivity(currentQuote.lead_id, lead?.c, 'quote_created', 'Quote $' + total.toFixed(2));
  showToast('✅ Quote saved!');
  const savedLeadId = currentQuote.lead_id;
  closeQuoteModal();
  // Reload quotes in modal if still open
  loadLeadQuotes(savedLeadId);
  return data;
}

async function saveAndDownloadQuote() {
  const quote = await saveQuote();
  if (!quote) return;
  const lead = leads.find(l => l.id === quote.lead_id);
  generateQuotePDF(quote, lead);
}

function generateQuotePDF(quote, lead) {
  const { subtotal, discount, total } = {
    subtotal: quote.items.reduce((s, i) => s + (i.subtotal || 0), 0),
    discount: quote.discount || 0,
    total: quote.total || 0
  };

  const statusColors = { draft: '#9db8a4', sent: '#60a5fa', approved: '#4ade80', declined: '#f87171' };
  const statusColor = statusColors[quote.status] || '#9db8a4';

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Quote — ${esc(lead?.c || '')}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a2e1f; background: #fff; padding: 40px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; padding-bottom: 24px; border-bottom: 3px solid #4ade80; }
  .logo { font-size: 28px; font-weight: 800; color: #16a34a; }
  .logo span { color: #f472b6; }
  .quote-meta { text-align: right; }
  .quote-num { font-size: 20px; font-weight: 700; color: #1a2e1f; }
  .quote-date { font-size: 12px; color: #6b9478; margin-top: 4px; }
  .status-badge { display: inline-block; padding: 3px 12px; border-radius: 20px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; background: ${statusColor}22; color: ${statusColor}; border: 1px solid ${statusColor}44; margin-top: 6px; }
  .section { margin-bottom: 32px; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #6b9478; margin-bottom: 10px; }
  .client-box { background: #f0f9f4; border: 1px solid #c8dace; border-radius: 8px; padding: 14px 18px; }
  .client-name { font-size: 16px; font-weight: 700; color: #1a2e1f; }
  .client-detail { font-size: 12px; color: #6b9478; margin-top: 3px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { padding: 10px 12px; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; color: #6b9478; border-bottom: 2px solid #c8dace; }
  thead th:last-child, thead th:nth-child(2), thead th:nth-child(3), thead th:nth-child(4) { text-align: right; }
  tbody td { padding: 10px 12px; border-bottom: 1px solid #e8f5ec; font-size: 13px; }
  tbody td:nth-child(2), tbody td:nth-child(3), tbody td:nth-child(4) { text-align: right; }
  tbody td:last-child { text-align: right; font-weight: 600; color: #16a34a; }
  .totals { margin-top: 16px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
  .total-row { display: flex; gap: 32px; font-size: 13px; }
  .total-row.final { font-size: 18px; font-weight: 800; color: #16a34a; padding-top: 8px; border-top: 2px solid #4ade80; }
  .total-label { color: #6b9478; }
  .notes-box { background: #f0f9f4; border-left: 4px solid #4ade80; padding: 12px 16px; border-radius: 0 8px 8px 0; font-size: 12px; color: #3a5c44; line-height: 1.6; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #c8dace; display: flex; justify-content: space-between; font-size: 11px; color: #9db8a4; }
  .valid { font-size: 12px; color: #f59e0b; font-weight: 600; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="logo"><span>Flora</span>Force</div>
      <div style="font-size:11px;color:#6b9478;margin-top:4px">Full Pot of Flowers · info@fullpot.com</div>
    </div>
    <div class="quote-meta">
      <div class="quote-num">QUOTE #${quote.id?.substring(0,8).toUpperCase()}</div>
      <div class="quote-date">Date: ${new Date(quote.created_at || Date.now()).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})}</div>
      ${quote.valid_until ? '<div class="valid">Valid until: ' + new Date(quote.valid_until).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}) + '</div>' : ''}
      <div><span class="status-badge">${quote.status}</span></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Bill To</div>
    <div class="client-box">
      <div class="client-name">${esc(lead?.c || '—')}</div>
      ${lead?.cn ? '<div class="client-detail">Contact: ' + esc(lead.cn) + '</div>' : ''}
      ${lead?.em ? '<div class="client-detail">Email: ' + esc(lead.em) + '</div>' : ''}
      ${lead?.ph ? '<div class="client-detail">Phone: ' + esc(lead.ph) + '</div>' : ''}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Items</div>
    <table>
      <thead>
        <tr>
          <th>Product / Description</th>
          <th>Qty</th>
          <th>Unit</th>
          <th>Unit Price</th>
          <th>Subtotal</th>
        </tr>
      </thead>
      <tbody>
        ${(quote.items || []).map(item => `
          <tr>
            <td>${esc(item.name || '—')}</td>
            <td>${item.qty}</td>
            <td>${esc(item.unit || 'unit')}</td>
            <td>$${parseFloat(item.price || 0).toFixed(2)}</td>
            <td>$${parseFloat(item.subtotal || 0).toFixed(2)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div class="totals">
      <div class="total-row"><span class="total-label">Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>
      ${discount > 0 ? '<div class="total-row"><span class="total-label">Discount (' + discount + '%)</span><span>-$' + (subtotal * discount / 100).toFixed(2) + '</span></div>' : ''}
      <div class="total-row final"><span class="total-label">Total</span><span>$${total.toFixed(2)}</span></div>
    </div>
  </div>

  ${quote.notes ? `
  <div class="section">
    <div class="section-title">Notes</div>
    <div class="notes-box">${esc(quote.notes).replace(/\n/g,'<br>')}</div>
  </div>` : ''}

  <div class="footer">
    <span>Prepared by: ${esc(quote.created_by_name || '—')}</span>
    <span>Full Pot of Flowers · fullpot.com</span>
  </div>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (win) {
    win.onload = () => { win.print(); URL.revokeObjectURL(url); };
  }
}

// ── START ─────────────────────────────────────────────────────
window.addEventListener('load', boot);
