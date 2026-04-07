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
  await loadLeadStates();
  await loadCallCount();

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
    responsible: l.responsible || ''
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
  if (!currentUser) return;
  const { data } = await sb.from('call_counts').select('calls')
    .eq('user_id', currentUser.id).eq('week_key', getWeek()).single();
  sessionCalls = data?.calls || 0;
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
    const sales   = l.sl ? '<span class="has-sales-dot"></span>$' + l.sl.total.toFixed(0) : '<span style="color:var(--text3)">—</span>';
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
      + '<td style="font-size:11px">' + sales + '</td>'
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
  sessionCalls++;
  applyFilters();
  updateProgress();
  saveLeadState(lead);
  saveCallCount();
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
    '<div class="modal-section"><div class="modal-section-title">📊 Sales History</div>' + salesHtml + '</div>'
    + '<div class="modal-section"><div class="modal-section-title">⏱ Last Contact</div><div style="padding:8px 0">' + lastContactInfo + '</div></div>'
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
function renderOwnerDropdown(currentOwner) {
  const vendors = allUsers.filter(u => u.role === 'vendor').map(u => u.name).sort();
  const current = currentOwner || '';
  // Include current owner even if not in profiles list (edge case)
  if (current && !vendors.includes(current)) vendors.push(current);
  const options = ['<option value="">— Unassigned —</option>']
    .concat(vendors.map(v => '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>'));
  return '<div class="info-item"><div class="info-item-lbl">Owner</div>'
    + '<div class="info-item-val"><select class="edit-field edit-select" data-key="responsible" onchange="updateLeadField(this)">'
    + options.join('') + '</select></div></div>';
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
    + '<div class="info-item"><div class="info-item-lbl">Pipeline</div><div class="info-item-val" style="font-size:11px;color:var(--text3)">' + esc(lead.p || '—') + '</div></div>'
    + '<div class="info-item"><div class="info-item-lbl">State</div><div class="info-item-val" style="font-size:11px;color:var(--text3)">' + esc(lead.st || '—') + '</div></div>';
}

function updateLeadField(input) {
  if (!currentLead) return;
  const key    = input.dataset.key;
  const oldVal = currentLead[key];
  const newVal = input.value;
  if (oldVal === newVal) return;
  currentLead[key] = newVal;
  // If reassigning owner, also update responsible field and log as transfer
  if (key === 'responsible') {
    currentLead.responsible = newVal;
    logActivity(currentLead.id, currentLead.c, 'transfer', (oldVal||'Unassigned') + ' → ' + (newVal||'Unassigned'));
    showToast('🔀 Reassigned to ' + (newVal || 'Unassigned'));
  } else {
    logActivity(currentLead.id, currentLead.c, 'field_edit', key + ': "' + oldVal + '" → "' + newVal + '"');
    showToast('✏️ ' + key + ' updated');
  }
  saveLeadState(currentLead);
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
  sessionCalls++;
  updateProgress();
  saveCallCount();
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

  // Revenue by owner removed (live data in Sales/Power BI tab)

  // Calls per vendor (admin sees all, vendor sees their own)
  const byRepCalls = {};
  pool.forEach(l => {
    const k = l.responsible || l.r;
    if (k) byRepCalls[k] = (byRepCalls[k] || 0) + (l.cc || 0);
  });
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
  document.getElementById('main').style.display    = goAdmin ? 'none' : 'flex';
  document.getElementById('sidebar').style.display = goAdmin ? 'none' : '';
  document.getElementById('admin-panel').style.display = goAdmin ? 'flex' : 'none';
  document.getElementById('btn-admin').textContent = goAdmin ? '📋 CRM' : '🛡 Admin';
  if (goAdmin) loadAdminData();
}
async function loadAdminData() {
  const { data } = await sb.from('profiles').select('*').order('name');
  allUsers = data || [];
  renderUsersTable();
  renderKanban();
  loadCallsLog();
  loadActivityLog();
}
function renderUsersTable() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;
  const lpu = {}, cpu = {};
  leads.forEach(l => {
    const r = l.responsible || l.r;
    if (r) {
      lpu[r] = (lpu[r] || 0) + 1;
      cpu[r] = (cpu[r] || 0) + (l.cc || 0);
    }
  });
  tbody.innerHTML = allUsers.map(u =>
    '<tr><td style="font-weight:500">' + esc(u.name) + '</td>'
    + '<td><span class="role-badge ' + (u.role==='admin'?'role-admin':'role-vendor') + '">' + u.role + '</span></td>'
    + '<td style="color:var(--accent);font-weight:600">' + (lpu[u.name]||0) + '</td>'
    + '<td style="color:#34d399;font-weight:600">📞 ' + (cpu[u.name]||0) + '</td>'
    + '<td><button onclick="deleteUser(this.dataset.uid,this.dataset.name)" data-uid="' + u.id + '" data-name="' + esc(u.name) + '" style="background:none;border:1px solid var(--danger);color:var(--danger);border-radius:6px;padding:2px 8px;font-size:10px;cursor:pointer" title="Delete user">🗑</button></td></tr>'
  ).join('');
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
  // Build lead name lookup
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

  // Read dates from inputs if custom
  const fromInput = document.getElementById('date-from').value;
  const toInput   = document.getElementById('date-to').value;
  if (fromInput) analyticsDateFrom = fromInput;
  if (toInput)   analyticsDateTo   = toInput;
  if (!analyticsDateFrom || !analyticsDateTo) return;

  const fromDate = new Date(analyticsDateFrom + 'T00:00:00');
  const toDate   = new Date(analyticsDateTo   + 'T23:59:59');

  // ── Fetch call logs in range ──
  const { data: callLogs } = await sb.from('intermedia_call_log')
    .select('*')
    .gte('called_at', fromDate.toISOString())
    .lte('called_at', toDate.toISOString());
  const calls = callLogs || [];

  // ── Use already-loaded leads ──
  const pool = leads;

  // ── Lead ID → lead map ──
  const leadMap = {};
  pool.forEach(l => { leadMap[l.id] = l; });

  // ── Build vendor stats ──
  const vendors = {};
  pool.forEach(l => {
    const name = l.responsible || l.r || 'Unassigned';
    if (!vendors[name]) vendors[name] = { name, leads:0, calls:0, durTotal:0, contacted:0, converted:0, revenue:0 };
    vendors[name].leads++;
    vendors[name].calls     += (l.cc || 0);
    if (l.lc) vendors[name].contacted++;
    if (l.cv) vendors[name].converted++;
    if (l.sl) vendors[name].revenue += (l.sl.total || 0);
  });

  // Overlay actual call log durations for the selected period
  calls.forEach(c => {
    const lead = leadMap[c.lead_id];
    const name = lead ? (lead.responsible || lead.r || 'Unassigned') : null;
    if (name && vendors[name]) {
      vendors[name].durTotal += (c.duration || 0);
    }
  });

  const vList = Object.values(vendors).filter(v => v.leads > 0).sort((a,b) => b.revenue - a.revenue);

  // ── KPI cards ──
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

  // ── Chart 1: Revenue by vendor + Calls by vendor ──
  const maxRev  = Math.max(...vList.map(v=>v.revenue), 1);
  const maxCall = Math.max(...vList.map(v=>v.calls), 1);

  document.getElementById('analytics-charts-1').innerHTML =
    '<div class="chart-card"><div class="chart-title">📞 Calls by Vendor</div><div class="bar-chart">'
    + vList.slice(0,8).map(v =>
        '<div class="bar-row"><div class="bar-label">'+esc(v.name)+'</div>'
        +'<div class="bar-track"><div class="bar-fill" style="width:'+(v.calls/maxCall*100).toFixed(0)+'%;background:linear-gradient(90deg,#34d399,#6ee7b7)"></div></div>'
        +'<div class="bar-val">'+v.calls+'</div></div>'
      ).join('') + '</div></div>';

  // ── Chart 2: Lead status funnel + Call direction split ──
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

  // ── Vendor performance table ──
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

// ── TABS / TOAST ──────────────────────────────────────────────
function switchTab(tab, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');

  const goSales = tab === 'sales';
  // Hide/show sidebar and main when going to sales (full width)
  document.getElementById('sidebar').style.display       = goSales ? 'none' : '';
  document.getElementById('main').style.display          = goSales ? 'none' : '';
  document.getElementById('sales-panel').style.display   = goSales ? 'block' : 'none';

  if (!goSales) {
    document.getElementById('tab-leads').style.display     = tab === 'leads'     ? 'block' : 'none';
    document.getElementById('tab-dashboard').style.display = tab === 'dashboard' ? 'block' : 'none';
    document.getElementById('tab-analytics').style.display = tab === 'analytics' ? 'block' : 'none';
  }

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

  // Get next available ID
  const maxId = leads.length ? Math.max(...leads.map(l => l.id || 0)) : 0;
  const newId = maxId + 1;

  // Insert into leads table
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

  // Insert lead state with notes
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

  // Add to local array immediately
  const newLead = {
    id: newId, c: company, p: 'New Lead',
    r: currentProfile?.name || '', st: state || '',
    ty: type || '', cn: contact || '', em: email || '',
    ph: phone || '', sl: null, cs: 'novo', tg: [], pr: false,
    cc: 0, lc: null, cv: false, cm: notes || '', tl: [],
    responsible: currentProfile?.name || ''
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
  if (!confirm('Delete user "' + userName + '"? This cannot be undone.\n\nTheir leads will become unassigned.')) return;

  // Delete profile (auth user requires service key - we delete profile only)
  const { error } = await sb.from('profiles').delete().eq('id', userId);
  if (error) { showToast('❌ Error: ' + error.message); return; }

  showToast('✅ User "' + userName + '" removed');
  logActivity(null, null, 'user_deleted', 'Removed user: ' + userName);
  await loadAdminData();
}

// ── DELETE LEAD ────────────────────────────────────────────────
async function deleteLead(id) {
  if (currentProfile?.role !== 'admin') return;
  const lead = leads.find(l => l.id === id);
  if (!lead) return;
  if (!confirm('Delete lead "' + lead.c + '"?\n\nThis cannot be undone.')) return;

  // Delete from lead_states first (FK)
  await sb.from('lead_states').delete().eq('lead_id', id);
  await sb.from('activity_log').delete().eq('lead_id', id);

  // Delete from leads table
  const { error } = await sb.from('leads').delete().eq('id', id);
  if (error) { showToast('❌ Error: ' + error.message); return; }

  // Remove from local array
  const idx = leads.findIndex(l => l.id === id);
  if (idx !== -1) leads.splice(idx, 1);

  logActivity(null, lead.c, 'lead_deleted', 'Lead deleted by admin');
  closeModal();
  applyFilters();
  showToast('🗑 Lead "' + lead.c.substring(0, 30) + '" deleted');
}

// ── START ─────────────────────────────────────────────────────
window.addEventListener('load', boot);
