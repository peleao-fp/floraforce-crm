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
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('crm-theme', next);
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = next === 'light' ? '🌙' : '☀️';
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
  await loadLeadStates(); // also calls loadIntermedaCallCounts
  await loadCallCount();  // uses intermedia data for weekly progress
  await loadMktTagTypes(); // preload so modal MKT Tag dropdown works

  setLoader('Ready!', 100);
  setTimeout(() => {
    hideLoader();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').classList.add('app-visible');
    if (currentProfile?.role === 'admin') {
      document.getElementById('btn-admin').style.display = '';
      document.getElementById('tab-btn-analytics').style.display = '';
      document.getElementById('tab-btn-sales').style.display = '';
    }
    if (currentProfile?.role === 'admin' || currentProfile?.role === 'mkt') {
      document.getElementById('btn-mkt').style.display = '';
    }
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
  const { data } = await sb.from('intermedia_call_log')
    .select('lead_id, called_at, user_name, direction, duration')
    .not('lead_id', 'is', null);
  if (!data) return;
  const counts = {}, lastCall = {}, callsByIntermediaName = {};
  data.forEach(c => {
    if (!c.lead_id) return;
    counts[c.lead_id] = (counts[c.lead_id] || 0) + 1;
    if (!lastCall[c.lead_id] || c.called_at > lastCall[c.lead_id]) {
      lastCall[c.lead_id] = c.called_at;
    }
    if (c.user_name) {
      callsByIntermediaName[c.user_name] = (callsByIntermediaName[c.user_name] || 0) + 1;
    }
  });
  // Store raw intermedia name counts for use when allUsers loads
  window._callsByIntermediaName = callsByIntermediaName;
  // Build profile map — works even if allUsers is empty, uses profiles from DB
  await buildCallsByProfile(callsByIntermediaName);
  // Apply real call counts to leads
  leads.forEach(l => {
    if (counts[l.id]) {
      l.cc = counts[l.id];
      const iLc = lastCall[l.id];
      if (iLc && (!l.lc || iLc > l.lc)) l.lc = iLc;
    }
  });
}

async function buildCallsByProfile(callsByIntermediaName) {
  // Load profiles if allUsers not yet populated
  let users = allUsers;
  if (!users || users.length === 0) {
    const { data } = await sb.from('profiles').select('name, role');
    users = data || [];
  }
  window._callsByProfile = {};
  users.forEach(u => {
    const pName = u.name.toLowerCase();
    let total = 0;
    Object.entries(callsByIntermediaName).forEach(([iName, cnt]) => {
      const iLower = iName.toLowerCase();
      const words = iLower.split(' ').filter(w => w.length > 3);
      if (pName.includes(iLower) || iLower.includes(pName) ||
          words.some(w => pName.includes(w))) {
        total += cnt;
      }
    });
    if (total > 0) window._callsByProfile[u.name] = total;
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
  const now = new Date();
  const day = now.getDay() || 7;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - day + 1);
  weekStart.setHours(0, 0, 0, 0);

  // Use same partial-match logic as buildCallsByProfile for consistency
  const { data } = await sb.from('intermedia_call_log')
    .select('user_name')
    .gte('called_at', weekStart.toISOString());

  if (data) {
    const pName = currentProfile.name.toLowerCase();
    sessionCalls = data.filter(c => {
      if (!c.user_name) return false;
      const iLower = c.user_name.toLowerCase();
      const words = iLower.split(' ').filter(w => w.length > 3);
      return pName === iLower
        || pName.includes(iLower)
        || iLower.includes(pName)
        || words.some(w => pName.includes(w));
    }).length;
  } else {
    sessionCalls = 0;
  }
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
  if (!currentProfile || currentProfile.role === 'admin') return leads;
  return leads.filter(l => (l.responsible || l.r) === currentProfile.name);
}
function populateFilters() {
  const pool   = getMyLeads();
  const pipes  = [...new Set(pool.map(l => l.p).filter(Boolean))].sort();
  const states = [...new Set(pool.map(l => l.st).filter(Boolean))].sort();
  const pSel   = document.getElementById('filter-pipeline');
  const sSel   = document.getElementById('filter-state');
  pipes.forEach(p  => { const o = document.createElement('option'); o.value = p;  o.textContent = p;  pSel.appendChild(o); });
  states.forEach(s => { const o = document.createElement('option'); o.value = s;  o.textContent = s;  sSel.appendChild(o); });
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
  const pipeline = document.getElementById('filter-pipeline')?.value || '';
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
function openModal(id) {
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
    + '<div class="modal-section"><div class="modal-section-title">📝 Lead Info</div><div class="info-grid" id="lead-info-grid">' + renderEditableFields(lead) + '</div></div>'
    + '<div class="modal-section"><div class="modal-section-title">⭐ Priority</div><label class="priority-toggle"><input type="checkbox" id="modal-priority" ' + (lead.pr ? 'checked' : '') + ' onchange="currentLead.pr=this.checked"><span>Mark as priority ⭐</span></label></div>'
    + '<div class="modal-section"><div class="modal-section-title">🏷 Tags</div>'
    + '<div class="tags-input-row"><input type="text" class="tags-input" id="tag-input" placeholder="Add tag..." onkeydown="if(event.key===\'Enter\'){addTag();event.preventDefault()}"><button class="btn btn-ghost" onclick="addTag()">+ Add</button></div>'
    + '<div class="tags-display" id="tags-display"></div>'
    + '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">'
    + ['callback','no answer','interested','unavailable','voicemail','speak with owner'].map(t => '<span class="chip" style="font-size:10px;padding:3px 8px" onclick="addTagQuick(\'' + t + '\')">' + t + '</span>').join('')
    + '</div></div>'
    + '<div class="modal-section"><div class="modal-section-title">📄 Notes</div><textarea class="modal-textarea" id="modal-comments" placeholder="General notes...">' + esc(lead.cm || '') + '</textarea></div>'
    + '<div class="modal-section"><div class="modal-section-title">📞 Call Log</div><div class="call-log">Total: <strong style="color:var(--accent)">' + (lead.cc || 0) + '</strong>' + (lead.lc ? ' · Last: <strong>' + new Date(lead.lc).toLocaleString('en-US') + '</strong>' : ' · None') + '</div></div>'
    + '<div class="modal-section"><div class="modal-section-title">💬 Comment Timeline</div>'
    + '<div class="tl-add"><textarea id="tl-new-text" placeholder="Add comment..."></textarea><button class="btn btn-primary" style="height:60px" onclick="addTimelineEntry()">+ Add</button></div>'
    + '<div style="margin-top:12px" id="timeline-list"></div></div>';

  renderTagsDisplay();
  renderTimeline();

  const deleteBtn = currentProfile?.role === 'admin'
    ? '<button class="btn btn-danger" onclick="deleteLead(' + lead.id + ')" style="margin-right:auto">🗑 Delete Lead</button>'
    : '';
  document.getElementById('modal-footer').innerHTML =
    deleteBtn
    + '<button class="btn btn-ghost" onclick="registerCall()">📞 Log Call</button>'
    + '<button class="btn btn-primary" onclick="saveModal()">💾 Save</button>';

  document.getElementById('modal').style.display = 'flex';
}

// ── EDITABLE FIELDS ───────────────────────────────────────────
function renderPipelineDropdown(lead) {
  const pipelines = [...new Set(leads.map(l => l.p).filter(Boolean))].sort();
  const current = lead.p || '';
  const options = ['<option value="">— No pipeline —</option>']
    .concat(pipelines.map(p => '<option value="' + esc(p) + '"' + (p === current ? ' selected' : '') + '>' + esc(p) + '</option>'));
  return '<div class="info-item"><div class="info-item-lbl">Pipeline</div>'
    + '<div class="info-item-val"><select class="edit-field edit-select" data-key="p" onchange="updateLeadPipeline(this)">'
    + options.join('') + '</select></div></div>';
}

function renderOwnerDropdown(currentOwner) {
  const vendors = allUsers.filter(u => u.role === 'vendor').map(u => u.name).sort();
  const current = currentOwner || '';
  if (current && !vendors.includes(current)) vendors.push(current);
  const options = ['<option value="">— Unassigned —</option>']
    .concat(vendors.map(v => '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>'));
  return '<div class="info-item"><div class="info-item-lbl">Owner</div>'
    + '<div class="info-item-val"><select class="edit-field edit-select" data-key="responsible" onchange="updateLeadField(this)">'
    + options.join('') + '</select></div></div>';
}

function renderMktTagDropdown(lead) {
  const current = lead.mkt_tag || '';
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

function renderEditableFields(lead) {
  const field = (label, key, val, type) =>
    '<div class="info-item"><div class="info-item-lbl">' + label + '</div>'
    + '<div class="info-item-val"><input type="' + (type||'text') + '" class="edit-field" data-key="' + key + '" value="' + esc(val||'') + '" placeholder="' + label + '..." onchange="updateLeadField(this)"></div></div>';

  return field('Company',     'c',           lead.c)
    + field('Contact',        'cn',          lead.cn)
    + field('Email',          'em',          lead.em, 'email')
    + field('Phone',          'ph',          lead.ph, 'tel')
    + renderOwnerDropdown(lead.responsible || lead.r)
    + field('Type',           'ty',          lead.ty)
    + renderPipelineDropdown(lead)
    + '<div class="info-item"><div class="info-item-lbl">State</div><div class="info-item-val" style="font-size:11px;color:var(--text3)">' + esc(lead.st || '—') + '</div></div>'
    + renderMktTagDropdown(lead);
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
  const key    = input.dataset.key;
  const oldVal = currentLead[key];
  const newVal = input.value;
  if (oldVal === newVal) return;
  currentLead[key] = newVal;
  if (key === 'responsible') {
    currentLead.responsible = newVal;
    await sb.from('leads').update({ responsible: newVal || '' }).eq('id', currentLead.id);
    logActivity(currentLead.id, currentLead.c, 'transfer', (oldVal||'Unassigned') + ' → ' + (newVal||'Unassigned'));
    showToast('🔀 Reassigned to ' + (newVal || 'Unassigned'));
  } else {
    logActivity(currentLead.id, currentLead.c, 'field_edit', key + ': "' + oldVal + '" → "' + newVal + '"');
    showToast('✏️ ' + key + ' updated');
  }
  saveLeadState(currentLead);
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
    ['Company', 'Contact', 'Email', 'Phone', 'Owner', 'Pipeline', 'Type', 'Status', 'State', 'Calls', 'Last Contact', 'Tags', 'MKT Tag']
  ];
  pool.forEach(l => {
    rows.push([
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
let MC_API_KEY = null;
const MC_DC   = 'us5';
const MC_BASE = 'https://' + MC_DC + '.api.mailchimp.com/3.0';
let mktTagTypes = [];
let mktSortCol = 'c', mktSortDir = 1, mktSearch = '';

async function loadMcApiKey() {
  if (MC_API_KEY) return MC_API_KEY;
  const { data } = await sb.from('app_settings')
    .select('value').eq('key', 'mailchimp_api_key').single();
  MC_API_KEY = data?.value || null;
  return MC_API_KEY;
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
  renderMktTagManager();
  await saveMktTagTypes();
  refreshMktPreview();
  showToast('✅ Tag "' + val + '" added');
}

async function removeMktTagType(i) {
  const removed = mktTagTypes.splice(i, 1)[0];
  renderMktTagManager();
  await saveMktTagTypes();
  refreshMktPreview();
  showToast('🗑 Tag "' + removed + '" removed');
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

  const pipeEl = document.getElementById('mkt-filter-pipeline');
  const pipes = [...new Set(leads.map(l => l.p).filter(Boolean))].sort();
  pipeEl.innerHTML = '<option value="">All Pipelines</option>'
    + pipes.map(p => '<option value="' + esc(p) + '">' + esc(p) + '</option>').join('');

  const vendEl = document.getElementById('mkt-filter-vendor');
  const { data: profs } = await sb.from('profiles').select('name').eq('role', 'vendor').order('name');
  vendEl.innerHTML = '<option value="">All Vendors</option>'
    + (profs || []).map(p => '<option value="' + esc(p.name) + '">' + esc(p.name) + '</option>').join('');

  await loadMcAudiences();
  renderMktTagManager();
  refreshMktPreview();
}

async function loadMcAudiences() {
  const key = await loadMcApiKey();
  const sel = document.getElementById('mkt-audience-select');
  if (!key) { sel.innerHTML = '<option value="">No API key configured</option>'; return; }
  try {
    const res = await fetch(MC_BASE + '/lists?count=50', {
      headers: { 'Authorization': 'Basic ' + btoa('any:' + key) }
    });
    const data = await res.json();
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
  const pipeline  = document.getElementById('mkt-filter-pipeline')?.value || '';
  const status    = document.getElementById('mkt-filter-status')?.value   || '';
  const vendor    = document.getElementById('mkt-filter-vendor')?.value   || '';
  const emailOnly = document.getElementById('mkt-filter-email')?.value    !== '';
  const mktTag    = document.getElementById('mkt-filter-tag')?.value      || '';

  return leads.filter(l => {
    if (pipeline && l.p !== pipeline)                              return false;
    if (status   && l.cs !== status)                               return false;
    if (vendor   && (l.responsible || l.r) !== vendor)            return false;
    if (emailOnly && !l.em)                                        return false;
    if (mktTag   && l.mkt_tag !== mktTag)                         return false;
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

function refreshMktPreview() {
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
  const tagOptions = ['<option value="">— No tag —</option>']
    .concat(mktTagTypes.map(t => '<option value="' + esc(t) + '">' + esc(t) + '</option>'));

  tbody.innerHTML = display.map(l =>
    '<tr>'
    + '<td>' + esc(l.c || '—') + '</td>'
    + '<td>' + esc(l.cn || '—') + '</td>'
    + '<td style="color:var(--accent)">' + esc(l.em) + '</td>'
    + '<td><span style="font-size:10px;padding:2px 7px;border-radius:10px;background:var(--accent-dim);color:var(--accent)">' + esc(l.cs || '—') + '</span></td>'
    + '<td style="font-size:11px;color:var(--text3)">' + esc((l.p||'').split(' - ').pop()||'—') + '</td>'
    + '<td style="font-size:11px">' + esc(l.responsible || l.r || '—') + '</td>'
    + '<td>'
      + '<select class="mkt-tag-select" onchange="saveMktTag(' + l.id + ',this.value)" style="background:var(--bg);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:3px 7px;font-size:11px;cursor:pointer;min-width:100px">'
      + tagOptions.map(o => o.replace('value="' + esc(l.mkt_tag||'') + '"', 'value="' + esc(l.mkt_tag||'') + '" selected')).join('')
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

async function exportToMailchimp() {
  const pool = getMktLeads().filter(l => l.em);
  if (!pool.length) { showToast('⚠️ No leads with email to export'); return; }

  const key = await loadMcApiKey();
  if (!key) { showToast('❌ Mailchimp API key not configured'); return; }

  const btn = document.getElementById('mkt-export-btn');
  const statusEl = document.getElementById('mkt-export-status');
  const progressWrap = document.getElementById('mkt-progress-wrap');
  const progressBar  = document.getElementById('mkt-progress-bar');
  const progressLbl  = document.getElementById('mkt-progress-label');

  let listId = document.getElementById('mkt-audience-select').value;
  const newName = document.getElementById('mkt-new-list-name').value.trim();

  if (!listId && !newName) { showToast('⚠️ Select a list or enter a new list name'); return; }

  btn.disabled = true;
  btn.textContent = '⏳ Exporting...';
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';

  try {
    if (!listId && newName) {
      statusEl.textContent = 'Creating list...';
      const res = await fetch(MC_BASE + '/lists', {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa('any:' + key),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: newName,
          contact: { company: 'Full Pot of Flowers', address1: 'Florida', city: 'Florida', state: 'FL', zip: '33000', country: 'US' },
          permission_reminder: 'You are receiving this because you are a customer or lead of Full Pot of Flowers.',
          email_type_option: false,
          campaign_defaults: { from_name: 'Full Pot of Flowers', from_email: 'info@fullpot.com', subject: '', language: 'en' }
        })
      });
      const data = await res.json();
      if (!data.id) throw new Error(data.title || 'Failed to create list');
      listId = data.id;
      await loadMcAudiences();
      document.getElementById('mkt-audience-select').value = listId;
    }

    const tag = document.getElementById('mkt-tag').value.trim();
    const CHUNK = 500;
    let done = 0, errors = 0;

    for (let i = 0; i < pool.length; i += CHUNK) {
      const chunk = pool.slice(i, i + CHUNK);
      const members = chunk.map(l => {
        const member = {
          email_address: l.em.toLowerCase().trim(),
          status: 'subscribed',
          merge_fields: {
            FNAME: (l.cn || '').split(' ')[0] || '',
            LNAME: (l.cn || '').split(' ').slice(1).join(' ') || '',
            COMPANY: l.c || ''
          }
        };
        if (tag) member.tags = [tag];
        return member;
      });

      const res = await fetch(MC_BASE + '/lists/' + listId + '/members/batch-subscribe/json', {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa('any:' + key),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ members, update_existing: true })
      });
      const data = await res.json();
      done += (data.new_members?.length || 0) + (data.updated_members?.length || 0);
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
    statusEl.textContent = '❌ ' + err.message;
    showToast('❌ Export failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '📤 Export to Mailchimp';
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
  closeModal();
  applyFilters();
  showToast('🗑 Lead "' + lead.c.substring(0, 30) + '" deleted');
}

// ── START ─────────────────────────────────────────────────────
window.addEventListener('load', boot);
