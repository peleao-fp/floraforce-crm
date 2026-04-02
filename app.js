/* ============================================================
   FloraForce CRM — Application Logic
   ============================================================
   Sections:
     SUPABASE CONFIG
     STATE
     BOOT
     AUTH
     LEAD STATES — SUPABASE
     CALL COUNT
     ACTIVITY LOG
     SYNC INDICATOR
     FILTERS
     TABLE
     QUICK CALL
     MODAL
     STATS + PROGRESS
     DASHBOARD
     ADMIN — USERS
     ADMIN — KANBAN LEAD TRANSFER
     ADMIN — ACTIVITY LOG
     VIEW TOGGLE (CRM ↔ Admin)
     TABS / TOAST / SHARED
   ============================================================ */

// ══════════════════════════════════════════════════════
// SUPABASE CONFIG
// ══════════════════════════════════════════════════════
let supabase = null;

function getConfig() {
  return {
    url: localStorage.getItem('sb_url') || '',
    key: localStorage.getItem('sb_key') || ''
  };
}

function saveConfig() {
  const url = document.getElementById('cfg-url').value.trim();
  const key = document.getElementById('cfg-key').value.trim();
  if (!url || !key) { showToast('⚠️ Preencha URL e Key'); return; }
  localStorage.setItem('sb_url', url);
  localStorage.setItem('sb_key', key);
  document.getElementById('config-modal').style.display = 'none';
  initSupabase();
  showLoginScreen();
}

function initSupabase() {
  const {url, key} = getConfig();
  if (!url || !key) return false;
  supabase = window.supabase.createClient(url, key);
  return true;
}

// ══════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════
let leads = JSON.parse(JSON.stringify(BASE_LEADS));
let filteredLeads = [];
let currentPage = 1;
const PER_PAGE = 50;
let currentLead = null;
let currentUser = null;
let currentProfile = null;
let sessionCalls = 0;
let activeStatus = 'all';
let activeSpecials = new Set();
let sortMode = 'default';
let allUsers = [];
let kanbanData = {};
let viewMode = 'crm'; // 'crm' | 'admin'

// ══════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════
function setLoader(msg, pct) {
  document.getElementById('loader-msg').textContent = msg;
  if (pct !== undefined) document.getElementById('loader-fill').style.width = pct + '%';
}

async function boot() {
  setLoader('Verificando configuração...', 10);
  const cfg = getConfig();
  if (!cfg.url || !cfg.key) {
    hideLoader();
    document.getElementById('config-modal').style.display = 'flex';
    return;
  }
  initSupabase();
  setLoader('Verificando sessão...', 30);
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    hideLoader();
    showLoginScreen();
    return;
  }
  await loadApp(session.user);
}

function hideLoader() {
  document.getElementById('loading-screen').style.display = 'none';
}

function showLoginScreen() {
  hideLoader();
  document.getElementById('login-screen').style.display = 'flex';
}

async function loadApp(user) {
  setLoader('Carregando perfil...', 50);
  currentUser = user;
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  currentProfile = profile;
  setLoader('Carregando dados dos leads...', 70);
  await loadLeadStates();
  await loadCallCount();
  setLoader('Montando interface...', 90);
  checkConversions();
  populateFilters();
  applyFilters();
  renderDashboard();
  updateUI();
  setLoader('Pronto!', 100);
  setTimeout(() => {
    hideLoader();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    if (currentProfile?.role === 'admin') {
      document.getElementById('btn-admin-toggle').style.display = '';
      loadAllUsers();
    }
  }, 200);
}

// ══════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════
async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;
  const btn   = document.getElementById('login-btn');
  const err   = document.getElementById('login-error');
  err.style.display = 'none';
  btn.disabled = true; btn.textContent = 'Entrando...';
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: pass });
  if (error) {
    err.textContent = 'Email ou senha incorretos.';
    err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Entrar';
    return;
  }
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('loading-screen').style.display = 'flex';
  await logActivity(data.user.id, null, null, 'login', 'Login realizado');
  await loadApp(data.user);
}

async function doLogout() {
  await supabase.auth.signOut();
  location.reload();
}

// ══════════════════════════════════════════════════════
// LEAD STATES — SUPABASE
// ══════════════════════════════════════════════════════
async function loadLeadStates() {
  const { data, error } = await supabase.from('lead_states').select('*');
  if (error || !data) return;
  const map = {};
  data.forEach(s => { map[s.lead_id] = s; });
  leads.forEach(l => {
    const s = map[l.id];
    if (!s) return;
    l.cs  = s.cs || 'novo';
    l.tg  = s.tags || [];
    l.pr  = s.priority || false;
    l.cc  = s.call_count || 0;
    l.lc  = s.last_call || null;
    l.cv  = s.converted || false;
    l.cm  = s.notes || '';
    l.tl  = s.timeline || [];
    l.responsible = s.responsible || l.r;
  });
}

async function saveLeadState(lead) {
  setSyncStatus('syncing');
  const payload = {
    lead_id:    lead.id,
    responsible: lead.responsible || lead.r,
    cs:         lead.cs,
    tags:       lead.tg || [],
    priority:   lead.pr || false,
    call_count: lead.cc || 0,
    last_call:  lead.lc || null,
    converted:  lead.cv || false,
    notes:      lead.cm || '',
    timeline:   lead.tl || [],
    updated_by: currentUser?.id,
    updated_at: new Date().toISOString()
  };
  const { error } = await supabase.from('lead_states').upsert(payload, { onConflict: 'lead_id' });
  setSyncStatus(error ? 'error' : 'ok');
}

// ══════════════════════════════════════════════════════
// CALL COUNT
// ══════════════════════════════════════════════════════
function getISOWeek() {
  const d = new Date(), day = d.getDay()||7;
  d.setUTCDate(d.getUTCDate()+4-day);
  const ys = new Date(Date.UTC(d.getUTCFullYear(),0,1));
  return `${d.getUTCFullYear()}-W${Math.ceil((((d-ys)/86400000)+1)/7)}`;
}

async function loadCallCount() {
  if (!currentUser) return;
  const week = getISOWeek();
  const { data } = await supabase.from('call_counts').select('calls').eq('user_id', currentUser.id).eq('week_key', week).single();
  sessionCalls = data?.calls || 0;
  updateProgress();
}

async function saveCallCount() {
  if (!currentUser) return;
  await supabase.from('call_counts').upsert({
    user_id: currentUser.id,
    vendor_name: currentProfile?.name || '',
    week_key: getISOWeek(),
    calls: sessionCalls,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,week_key' });
}

// ══════════════════════════════════════════════════════
// ACTIVITY LOG
// ══════════════════════════════════════════════════════
async function logActivity(userId, leadId, leadName, action, detail) {
  await supabase.from('activity_log').insert({
    user_id:   userId || currentUser?.id,
    user_name: currentProfile?.name || 'Unknown',
    lead_id:   leadId,
    lead_name: leadName,
    action,
    detail
  });
}

// ══════════════════════════════════════════════════════
// SYNC INDICATOR
// ══════════════════════════════════════════════════════
function setSyncStatus(s) {
  const dot = document.getElementById('sync-dot');
  const lbl = document.getElementById('sync-lbl');
  if (s==='syncing') { dot.className='sync-dot syncing'; lbl.textContent='Salvando...'; }
  else if (s==='ok') { dot.className='sync-dot'; lbl.textContent='Sincronizado'; }
  else              { dot.className='sync-dot error'; lbl.textContent='Erro'; }
}

// ══════════════════════════════════════════════════════
// FILTERS
// ══════════════════════════════════════════════════════
function getMyLeads() {
  if (!currentProfile) return leads;
  if (currentProfile.role === 'admin') return leads;
  const myName = currentProfile.name;
  return leads.filter(l => (l.responsible || l.r) === myName);
}

function populateFilters() {
  const myLeads = getMyLeads();
  const pipes  = [...new Set(myLeads.map(l=>l.p).filter(Boolean))].sort();
  const states = [...new Set(myLeads.map(l=>l.st).filter(Boolean))].sort();
  const pSel = document.getElementById('filter-pipeline');
  const sSel = document.getElementById('filter-state');
  pipes.forEach(p=>{const o=document.createElement('option');o.value=p;o.textContent=p;pSel.appendChild(o);});
  states.forEach(s=>{const o=document.createElement('option');o.value=s;o.textContent=s;sSel.appendChild(o);});
}

function toggleStatus(el,val) {
  document.querySelectorAll('#status-chips .chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active'); activeStatus=val; currentPage=1; applyFilters();
}
function toggleSpecial(el,val) {
  el.classList.toggle('active');
  activeSpecials.has(val)?activeSpecials.delete(val):activeSpecials.add(val);
  currentPage=1; applyFilters();
}

function applyFilters() {
  const search   = document.getElementById('search-input').value.toLowerCase();
  const pipeline = document.getElementById('filter-pipeline').value;
  const type     = document.getElementById('filter-type').value;
  const state    = document.getElementById('filter-state').value;
  const pool     = getMyLeads();
  filteredLeads = pool.filter(l => {
    if (activeStatus !== 'all' && l.cs !== activeStatus) return false;
    if (pipeline && l.p !== pipeline) return false;
    if (type && !l.ty.includes(type)) return false;
    if (state && l.st !== state) return false;
    if (activeSpecials.has('priority') && !l.pr) return false;
    if (activeSpecials.has('has_sales') && !l.sl) return false;
    if (activeSpecials.has('has_phone') && !l.ph) return false;
    if (search) { const h=(l.c+' '+l.cn+' '+l.em+' '+l.ct).toLowerCase(); if (!h.includes(search)) return false; }
    return true;
  });
  if (sortMode==='priority') filteredLeads.sort((a,b)=>(b.pr?1:0)-(a.pr?1:0));
  else if (sortMode==='calls') filteredLeads.sort((a,b)=>b.cc-a.cc);
  else if (sortMode==='company') filteredLeads.sort((a,b)=>a.c.localeCompare(b.c));
  else if (sortMode==='sales') filteredLeads.sort((a,b)=>(b.sl?b.sl.total:0)-(a.sl?a.sl.total:0));
  else filteredLeads.sort((a,b)=>(b.pr?1:0)-(a.pr?1:0));
  currentPage=1; renderTable(); renderPagination(); updateMiniStats(); updateTopbarStats();
}
function sortBy(m){sortMode=m;applyFilters();}

// ══════════════════════════════════════════════════════
// TABLE
// ══════════════════════════════════════════════════════
function statusBadge(cs){return{novo:'<span class="badge badge-novo">Novo</span>',contatado:'<span class="badge badge-contatado">Contatado</span>',proposta:'<span class="badge badge-proposta">Proposta</span>',cliente:'<span class="badge badge-cliente">Cliente ✓</span>'}[cs]||'<span class="badge">—</span>';}
function escHtml(s){if(!s)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function renderTable() {
  const start=(currentPage-1)*PER_PAGE, page=filteredLeads.slice(start,start+PER_PAGE);
  document.getElementById('lc-shown').textContent=filteredLeads.length.toLocaleString();
  document.getElementById('lc-total').textContent=getMyLeads().length.toLocaleString();
  const tbody=document.getElementById('leads-tbody');
  if(!filteredLeads.length){tbody.innerHTML='<tr><td colspan="9"><div class="empty-state"><h3>Nenhum lead encontrado</h3><p>Ajuste os filtros</p></div></td></tr>';return;}
  tbody.innerHTML=page.map(l=>{
    const tags=(l.tg||[]).slice(0,2).map(t=>`<span class="tag-pill">${escHtml(t)}</span>`).join('');
    const hasSales=l.sl?`<span class="has-sales-dot"></span>$${l.sl.total.toFixed(0)}`:'<span style="color:var(--text3)">—</span>';
    const st=l.st?(l.st.split(' - ')[1]||l.st):'—';
    const ty=l.ty?l.ty.split(';')[0]:'—';
    return `<tr class="${l.pr?'priority-row':''}" onclick="openModal(${l.id})">
      <td>${l.pr?'<span class="priority-star">⭐</span>':''}</td>
      <td class="td-company">${escHtml(l.c)}<small>${escHtml(l.cn||'—')}</small></td>
      <td style="font-size:11px">${st}</td>
      <td style="font-size:10px;color:var(--text3)">${ty}</td>
      <td>${statusBadge(l.cs)}</td>
      <td>${tags}</td>
      <td style="text-align:center;font-size:12px;color:${l.cc>0?'var(--accent)':'var(--text3)'}">${l.cc}</td>
      <td style="font-size:11px">${hasSales}</td>
      <td><button class="btn btn-ghost" style="padding:4px 10px;font-size:11px" onclick="event.stopPropagation();quickCall(${l.id})">📞</button></td>
    </tr>`;
  }).join('');
}

function renderPagination(){
  const total=Math.ceil(filteredLeads.length/PER_PAGE),pg=document.getElementById('pagination');
  if(total<=1){pg.innerHTML='';return;}
  let h=`<button class="page-btn" onclick="goPage(${currentPage-1})" ${currentPage===1?'disabled':''}>◀</button>`;
  const r=[];for(let i=Math.max(1,currentPage-2);i<=Math.min(total,currentPage+2);i++)r.push(i);
  if(r[0]>1){h+=`<button class="page-btn" onclick="goPage(1)">1</button>`;if(r[0]>2)h+='<span style="color:var(--text3);padding:0 4px">…</span>';}
  r.forEach(p=>{h+=`<button class="page-btn ${p===currentPage?'active':''}" onclick="goPage(${p})">${p}</button>`;  });
  if(r[r.length-1]<total){if(r[r.length-1]<total-1)h+='<span style="color:var(--text3);padding:0 4px">…</span>';h+=`<button class="page-btn" onclick="goPage(${total})">${total}</button>`;}
  h+=`<button class="page-btn" onclick="goPage(${currentPage+1})" ${currentPage===total?'disabled':''}>▶</button>`;
  pg.innerHTML=h;
}
function goPage(p){const t=Math.ceil(filteredLeads.length/PER_PAGE);if(p<1||p>t)return;currentPage=p;renderTable();renderPagination();}

// ══════════════════════════════════════════════════════
// QUICK CALL
// ══════════════════════════════════════════════════════
async function quickCall(id) {
  const lead=leads.find(l=>l.id===id);if(!lead)return;
  lead.cc=(lead.cc||0)+1;lead.lc=new Date().toISOString();
  if(lead.cs==='novo')lead.cs='contatado';
  sessionCalls++;applyFilters();updateProgress();
  saveLeadState(lead);saveCallCount();
  logActivity(null,lead.id,lead.c,'call',`Ligação #${lead.cc}`);
  showToast('📞 Ligação registrada: '+lead.c.substring(0,25));
}

// ══════════════════════════════════════════════════════
// MODAL
// ══════════════════════════════════════════════════════
function openModal(id) {
  const lead=leads.find(l=>l.id===id);if(!lead)return;
  currentLead=lead;
  document.getElementById('modal-company').textContent=lead.c;
  document.getElementById('modal-sub').textContent=[lead.cn,lead.st?(lead.st.split(' - ')[1]||''):'',lead.country].filter(Boolean).join(', ')||'Sem localização';
  const salesHtml=lead.sl
    ?`<div class="sales-card"><div style="display:flex;justify-content:space-between;align-items:flex-start"><div><div class="sales-card-val">$${lead.sl.total.toFixed(2)}</div><div class="sales-card-sub">${lead.sl.count} pedidos · Rep: ${lead.sl.rep}</div></div><span class="badge badge-cliente">Histórico</span></div></div>`
    :'<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text3);font-size:12px">Sem histórico de compras</div>';
  document.getElementById('modal-body').innerHTML=`
    <div class="modal-section"><div class="modal-section-title">Histórico de Vendas</div>${salesHtml}</div>
    <div class="modal-section">
      <div class="modal-section-title">Status</div>
      <div class="status-row" id="modal-status-row">
        ${['novo','contatado','proposta','cliente'].map(s=>`<button class="status-btn ${lead.cs===s?'sel':''}" onclick="setStatus('${s}')">
          ${{'novo':'🔵 Novo','contatado':'🟡 Contatado','proposta':'🟣 Proposta','cliente':'🟢 Cliente'}[s]}</button>`).join('')}
      </div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Contato</div>
      <div class="info-grid">
        <div class="info-item"><div class="info-item-lbl">Contato</div><div class="info-item-val">${escHtml(lead.cn||'—')}</div></div>
        <div class="info-item"><div class="info-item-lbl">Telefone</div><div class="info-item-val">${lead.ph?`<a href="tel:${lead.ph}">${escHtml(lead.ph)}</a>`:'—'}</div></div>
        <div class="info-item"><div class="info-item-lbl">Email</div><div class="info-item-val">${lead.em?`<a href="mailto:${lead.em}">${escHtml(lead.em)}</a>`:'—'}</div></div>
        <div class="info-item"><div class="info-item-lbl">Tipo</div><div class="info-item-val">${escHtml(lead.ty||'—')}</div></div>
        <div class="info-item"><div class="info-item-lbl">Responsável</div><div class="info-item-val">${escHtml(lead.responsible||lead.r||'—')}</div></div>
        <div class="info-item"><div class="info-item-lbl">Pipeline</div><div class="info-item-val" style="font-size:11px">${escHtml(lead.p||'—')}</div></div>
        ${lead.ig?`<div class="info-item"><div class="info-item-lbl">Instagram</div><div class="info-item-val"><a href="${escHtml(lead.ig)}" target="_blank">Ver ↗</a></div></div>`:''}
        ${lead.wb?`<div class="info-item"><div class="info-item-lbl">Website</div><div class="info-item-val"><a href="${escHtml(lead.wb)}" target="_blank">Abrir ↗</a></div></div>`:''}
      </div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Prioridade</div>
      <label class="priority-toggle"><input type="checkbox" id="modal-priority" ${lead.pr?'checked':''} onchange="setPriority(this.checked)"><span>Marcar como prioridade ⭐</span></label>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Tags</div>
      <div class="tags-input-row">
        <input type="text" class="tags-input" id="tag-input" placeholder="Adicionar tag..." onkeydown="if(event.key==='Enter'){addTag();event.preventDefault()}">
        <button class="btn btn-ghost" onclick="addTag()">+ Add</button>
      </div>
      <div class="tags-display" id="tags-display"></div>
      <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">
        ${['retornar','sem resposta','interessado','não disponível','voicemail','falar com dono'].map(t=>`<span class="chip" style="font-size:10px;padding:3px 8px" onclick="addTagQuick('${t}')">${t}</span>`).join('')}
      </div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Notas</div>
      <textarea class="modal-textarea" id="modal-comments" placeholder="Notas gerais...">${escHtml(lead.cm||'')}</textarea>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Ligações</div>
      <div class="call-log">📞 Total: <strong style="color:var(--accent)">${lead.cc||0}</strong>
        ${lead.lc?` · Última: <strong>${new Date(lead.lc).toLocaleString('pt-BR')}</strong>`:' · Nenhuma registrada'}
      </div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Timeline de Comentários</div>
      <div class="tl-add">
        <textarea id="tl-new-text" placeholder="Adicionar comentário..."></textarea>
        <button class="btn btn-primary" style="height:60px;white-space:nowrap" onclick="addTimelineEntry()">+ Adicionar</button>
      </div>
      <div style="margin-top:12px" id="timeline-list"></div>
    </div>
  `;
  renderTagsDisplay();renderTimeline();
  document.getElementById('modal-footer').innerHTML=`
    <button class="btn btn-danger" id="btn-undo-call" onclick="undoCall()" ${(lead.cc||0)===0?'disabled style="opacity:.3;cursor:not-allowed"':''}>↩ Desfazer</button>
    <button class="btn btn-ghost" onclick="registerCall()">📞 Registrar Ligação</button>
    <button class="btn btn-primary" onclick="saveModal()">💾 Salvar</button>
  `;
  document.getElementById('modal').style.display='flex';
}

function renderTagsDisplay(){const el=document.getElementById('tags-display');if(!el||!currentLead)return;el.innerHTML=(currentLead.tg||[]).map((t,i)=>`<span class="tag-rm">${escHtml(t)}<button onclick="removeTag(${i})">×</button></span>`).join('');}
function renderTimeline(){
  const el=document.getElementById('timeline-list');if(!el||!currentLead)return;
  const entries=currentLead.tl||[];
  if(!entries.length){el.innerHTML='<div class="tl-empty">Nenhum comentário ainda.</div>';return;}
  el.innerHTML='<div class="timeline">'+[...entries].reverse().map(e=>`
    <div class="tl-entry"><div class="tl-dot"></div><div class="tl-body">
      <div class="tl-meta"><span class="tl-vendor">👤 ${escHtml(e.v||'—')}</span><span class="tl-date">${new Date(e.ts).toLocaleString('pt-BR')}</span></div>
      <div class="tl-text">${escHtml(e.txt)}</div>
    </div></div>`).join('')+'</div>';
}
function addTimelineEntry(){
  if(!currentLead)return;
  const inp=document.getElementById('tl-new-text'),txt=inp.value.trim();
  if(!txt){showToast('⚠️ Digite um comentário');return;}
  if(!currentLead.tl)currentLead.tl=[];
  const entry={ts:new Date().toISOString(),v:currentProfile?.name||'—',txt};
  currentLead.tl.push(entry);inp.value='';renderTimeline();
  logActivity(null,currentLead.id,currentLead.c,'comment',txt.substring(0,80));
  showToast('💬 Comentário adicionado!');
}
function addTag(){const inp=document.getElementById('tag-input');if(!inp||!currentLead)return;const val=inp.value.trim();if(!val)return;if(!currentLead.tg)currentLead.tg=[];if(!currentLead.tg.includes(val))currentLead.tg.push(val);inp.value='';renderTagsDisplay();}
function addTagQuick(tag){if(!currentLead)return;if(!currentLead.tg)currentLead.tg=[];if(!currentLead.tg.includes(tag))currentLead.tg.push(tag);renderTagsDisplay();}
function removeTag(idx){if(currentLead){currentLead.tg.splice(idx,1);renderTagsDisplay();}}
function setStatus(s){
  if(!currentLead)return;const old=currentLead.cs;currentLead.cs=s;
  if(s==='cliente'){currentLead.cv=true;currentLead.lc=new Date().toISOString();}
  document.querySelectorAll('#modal-status-row .status-btn').forEach(b=>b.classList.toggle('sel',b.getAttribute('onclick').includes("'"+s+"'")));
  if(old!==s)logActivity(null,currentLead.id,currentLead.c,'status_change',`${old} → ${s}`);
}
function setPriority(val){if(currentLead)currentLead.pr=val;}
function updateCallLog(){
  const cl=document.querySelector('.call-log');if(!cl||!currentLead)return;
  cl.innerHTML=`📞 Total: <strong style="color:var(--accent)">${currentLead.cc}</strong>`+(currentLead.lc?` · Última: <strong>${new Date(currentLead.lc).toLocaleString('pt-BR')}</strong>`:' · Nenhuma registrada');
  const btn=document.getElementById('btn-undo-call');if(btn){btn.disabled=!currentLead.cc;btn.style.opacity=currentLead.cc?'1':'0.3';}
}
async function registerCall(){
  if(!currentLead)return;currentLead.cc=(currentLead.cc||0)+1;currentLead.lc=new Date().toISOString();
  if(currentLead.cs==='novo')currentLead.cs='contatado';sessionCalls++;updateCallLog();updateProgress();
  saveCallCount();logActivity(null,currentLead.id,currentLead.c,'call',`Ligação #${currentLead.cc}`);showToast('📞 Ligação registrada!');
}
async function undoCall(){
  if(!currentLead||!currentLead.cc)return;currentLead.cc--;if(!currentLead.cc)currentLead.lc=null;
  if(sessionCalls>0)sessionCalls--;updateCallLog();updateProgress();saveCallCount();showToast('↩ Ligação desfeita');
}
async function saveModal(){
  if(!currentLead)return;const cm=document.getElementById('modal-comments');if(cm)currentLead.cm=cm.value;
  await saveLeadState(currentLead);closeModal();applyFilters();showToast('✅ Lead salvo!');
}
function closeModal(){document.getElementById('modal').style.display='none';currentLead=null;}
function closeModalOutside(e){if(e.target===document.getElementById('modal'))closeModal();}

// ══════════════════════════════════════════════════════
// STATS + PROGRESS
// ══════════════════════════════════════════════════════
function checkConversions(){
  const now=Date.now();leads.forEach(l=>{if(l.cv&&l.lc){const diff=(now-new Date(l.lc).getTime())/(1000*60*60*24);if(diff>7){l.cv=false;l.cs='novo';l.lc=null;}}});
}
function updateTopbarStats(){
  document.getElementById('ts-total').textContent=filteredLeads.length.toLocaleString();
  document.getElementById('ts-calls').textContent=sessionCalls;
  document.getElementById('ts-conv').textContent=leads.filter(l=>l.cs==='cliente').length;
  document.getElementById('ts-priority').textContent=leads.filter(l=>l.pr).length;
}
function updateProgress(){
  const pct=Math.min(100,(sessionCalls/250)*100);
  document.getElementById('prog-fill').style.width=pct+'%';
  document.getElementById('calls-done').textContent=sessionCalls+' ligações';
  document.getElementById('ts-calls').textContent=sessionCalls;
}
function updateMiniStats(){
  document.getElementById('mini-shown').textContent=filteredLeads.length;
  document.getElementById('mini-priority').textContent=filteredLeads.filter(l=>l.pr).length;
  document.getElementById('mini-clients').textContent=filteredLeads.filter(l=>l.cs==='cliente').length;
  document.getElementById('mini-calls').textContent=filteredLeads.reduce((s,l)=>s+(l.cc||0),0);
}
function updateUI(){
  document.getElementById('user-name-chip').textContent=currentProfile?.name||currentUser?.email||'—';
  document.getElementById('user-role-chip').textContent=currentProfile?.role==='admin'?'Admin':'Vendedor';
  document.getElementById('user-role-label').textContent=currentProfile?.role==='admin'?'Admin':'CRM';
}

// ══════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════
function renderDashboard(){
  const s=SALES_DATA.summary, pool=getMyLeads();
  const withPhone=pool.filter(l=>l.ph).length,withEmail=pool.filter(l=>l.em).length,withSales=pool.filter(l=>l.sl).length;
  document.getElementById('kpi-grid').innerHTML=`
    <div class="kpi-card green"><div class="kpi-card-val">$${(s.total_revenue/1000).toFixed(0)}K</div><div class="kpi-card-lbl">Receita Março</div></div>
    <div class="kpi-card blue"><div class="kpi-card-val">${s.total_orders.toLocaleString()}</div><div class="kpi-card-lbl">Pedidos no Mês</div></div>
    <div class="kpi-card yellow"><div class="kpi-card-val">${pool.length.toLocaleString()}</div><div class="kpi-card-lbl">Meus Leads</div></div>
    <div class="kpi-card purple"><div class="kpi-card-val">${withSales}</div><div class="kpi-card-lbl">c/ Histórico de Compras</div></div>
    <div class="kpi-card green"><div class="kpi-card-val">${withPhone.toLocaleString()}</div><div class="kpi-card-lbl">Com Telefone</div></div>
    <div class="kpi-card blue"><div class="kpi-card-val">${withEmail.toLocaleString()}</div><div class="kpi-card-lbl">Com Email</div></div>
  `;
  const topReps=SALES_DATA.top_reps.slice(0,8),maxRep=topReps[0][1];
  const byPipe={};pool.forEach(l=>{byPipe[l.p]=(byPipe[l.p]||0)+1;});
  const pipeE=Object.entries(byPipe).sort((a,b)=>b[1]-a[1]),maxPipe=pipeE[0]?.[1]||1;
  const byType={};pool.forEach(l=>{if(!l.ty)return;l.ty.split(';').forEach(t=>{const tt=t.trim();byType[tt]=(byType[tt]||0)+1;});});
  const typeE=Object.entries(byType).sort((a,b)=>b[1]-a[1]),maxType=typeE[0]?.[1]||1;
  document.getElementById('charts-row').innerHTML=`
    <div class="chart-card"><div class="chart-title">💰 Receita por Vendedor (Março)</div><div class="bar-chart">${topReps.map(([r,v])=>`<div class="bar-row"><div class="bar-label" title="${r}">${r}</div><div class="bar-track"><div class="bar-fill" style="width:${(v/maxRep*100).toFixed(1)}%"></div></div><div class="bar-val">$${(v/1000).toFixed(0)}K</div></div>`).join('')}</div></div>
    <div class="chart-card"><div class="chart-title">📊 Pipeline dos meus Leads</div><div class="bar-chart">${pipeE.map(([p,v])=>`<div class="bar-row"><div class="bar-label" title="${p}">${p}</div><div class="bar-track"><div class="bar-fill" style="width:${(v/maxPipe*100).toFixed(1)}%;background:linear-gradient(90deg,#a78bfa,#c4b5fd)"></div></div><div class="bar-val">${v}</div></div>`).join('')}</div></div>
    <div class="chart-card"><div class="chart-title">🌸 Tipo de Cliente</div><div class="bar-chart">${typeE.map(([t,v])=>`<div class="bar-row"><div class="bar-label">${t}</div><div class="bar-track"><div class="bar-fill" style="width:${(v/maxType*100).toFixed(1)}%;background:linear-gradient(90deg,#f59e0b,#fbbf24)"></div></div><div class="bar-val">${v}</div></div>`).join('')}</div></div>
    <div class="chart-card"><div class="chart-title">📞 Status dos Leads</div><div class="bar-chart">
      ${['novo','contatado','proposta','cliente'].map(s=>{const cnt=pool.filter(l=>l.cs===s).length,colors={'novo':'#60a5fa','contatado':'#fbbf24','proposta':'#a78bfa','cliente':'#4ade80'};return`<div class="bar-row"><div class="bar-label">${s}</div><div class="bar-track"><div class="bar-fill" style="width:${pool.length?((cnt/pool.length)*100).toFixed(1):0}%;background:${colors[s]}"></div></div><div class="bar-val">${cnt}</div></div>`;}).join('')}
    </div></div>
  `;
}

// ══════════════════════════════════════════════════════
// ADMIN — USERS
// ══════════════════════════════════════════════════════
async function loadAllUsers() {
  const {data} = await supabase.from('profiles').select('*').order('name');
  allUsers = data || [];
  renderUsersTable();
  populateActivityFilter();
  loadKanban();
  loadActivityLog();
}

function renderUsersTable(){
  const tbody=document.getElementById('users-tbody');
  if(!tbody)return;
  const leadsPerUser={};
  leads.forEach(l=>{const r=l.responsible||l.r;if(r)leadsPerUser[r]=(leadsPerUser[r]||0)+1;});
  tbody.innerHTML=allUsers.map(u=>`
    <tr>
      <td style="font-weight:500">${escHtml(u.name)}</td>
      <td style="color:var(--text3);font-size:11px">—</td>
      <td><span class="role-badge ${u.role==='admin'?'role-admin':'role-vendor'}">${u.role}</span></td>
      <td style="color:var(--accent);font-weight:600">${leadsPerUser[u.name]||0}</td>
    </tr>`).join('');
}

async function createUser(){
  const name=document.getElementById('new-name').value.trim();
  const email=document.getElementById('new-email').value.trim();
  const pass=document.getElementById('new-pass').value;
  const role=document.getElementById('new-role').value;
  if(!name||!email||!pass){showToast('⚠️ Preencha todos os campos');return;}
  // Create auth user via Supabase Admin (requires service_role key)
  // For now we insert the profile and let user sign up themselves
  const {error} = await supabase.from('profiles').insert({name,role});
  if(error){showToast('❌ Erro: '+error.message);return;}
  showToast('✅ Perfil criado! O usuário deve se cadastrar com esse email.');
  await loadAllUsers();
}

// ══════════════════════════════════════════════════════
// ADMIN — KANBAN LEAD TRANSFER
// ══════════════════════════════════════════════════════
function loadKanban(){
  kanbanData={};
  const search=(document.getElementById('kanban-search')?.value||'').toLowerCase();
  // Group leads by responsible
  allUsers.filter(u=>u.role==='vendor').forEach(u=>{
    kanbanData[u.name]=leads.filter(l=>(l.responsible||l.r)===u.name&&(!search||l.c.toLowerCase().includes(search))).slice(0,20);
  });
  // Unassigned
  const unassigned=leads.filter(l=>{const r=l.responsible||l.r;return !r||!allUsers.find(u=>u.name===r);}).slice(0,20);
  if(unassigned.length)kanbanData['Não atribuído']=unassigned;
  renderKanban();
}

function renderKanban(){
  const wrap=document.getElementById('kanban-wrap');
  if(!wrap)return;
  const search=(document.getElementById('kanban-search')?.value||'').toLowerCase();
  wrap.innerHTML=Object.entries(kanbanData).map(([vendor,vleads])=>{
    const filtered=search?vleads.filter(l=>l.c.toLowerCase().includes(search)):vleads;
    return `<div class="kanban-col" data-vendor="${escHtml(vendor)}">
      <div class="kanban-col-header">${escHtml(vendor)}<span>${filtered.length}${filtered.length>=20?'+':''}</span></div>
      <div class="kanban-col-body" ondragover="onDragOver(event)" ondrop="onDrop(event,'${escHtml(vendor)}')" ondragleave="onDragLeave(event)">
        ${filtered.map(l=>`<div class="kanban-card" draggable="true" data-id="${l.id}" ondragstart="onDragStart(event,${l.id})">
          <div class="kanban-card-name" title="${escHtml(l.c)}">${escHtml(l.c)}</div>
          <div class="kanban-card-state">${{'novo':'🔵','contatado':'🟡','proposta':'🟣','cliente':'🟢'}[l.cs]||'⚪'} ${l.cs} ${l.cc>0?'· '+l.cc+' lig.':''} </div>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

let draggingId=null;
function onDragStart(e,id){draggingId=id;e.currentTarget.classList.add('dragging');e.dataTransfer.effectAllowed='move';}
function onDragOver(e){e.preventDefault();e.currentTarget.classList.add('drag-over');}
function onDragLeave(e){e.currentTarget.classList.remove('drag-over');}
async function onDrop(e,vendor){
  e.preventDefault();e.currentTarget.classList.remove('drag-over');
  if(!draggingId)return;
  const lead=leads.find(l=>l.id===draggingId);if(!lead)return;
  const oldVendor=lead.responsible||lead.r;
  lead.responsible=vendor;
  // Update kanban data
  Object.keys(kanbanData).forEach(v=>{kanbanData[v]=kanbanData[v].filter(l=>l.id!==draggingId);});
  if(!kanbanData[vendor])kanbanData[vendor]=[];
  kanbanData[vendor].push(lead);
  renderKanban();
  await saveLeadState(lead);
  logActivity(null,lead.id,lead.c,'transfer',`${oldVendor} → ${vendor}`);
  showToast(`✅ "${lead.c.substring(0,20)}" transferido para ${vendor}`);
  draggingId=null;
}

// ══════════════════════════════════════════════════════
// ADMIN — ACTIVITY LOG
// ══════════════════════════════════════════════════════
function populateActivityFilter(){
  const sel=document.getElementById('activity-filter');if(!sel)return;
  allUsers.forEach(u=>{const o=document.createElement('option');o.value=u.name;o.textContent=u.name;sel.appendChild(o);});
}

async function loadActivityLog(){
  const el=document.getElementById('activity-list');if(!el)return;
  const filter=document.getElementById('activity-filter')?.value||'';
  let q=supabase.from('activity_log').select('*').order('created_at',{ascending:false}).limit(50);
  if(filter)q=q.eq('user_name',filter);
  const {data}=await q;
  if(!data||!data.length){el.innerHTML='<div style="color:var(--text3);font-size:12px;text-align:center;padding:20px">Nenhuma atividade registrada ainda</div>';return;}
  const icons={'call':'📞','status_change':'🔄','comment':'💬','tag':'🏷','transfer':'🔀','login':'🔑'};
  el.innerHTML=data.map(a=>`
    <div class="activity-item">
      <div class="act-icon">${icons[a.action]||'📝'}</div>
      <div class="act-body">
        <strong>${escHtml(a.user_name||'—')}</strong>
        ${a.action==='call'?'registrou uma ligação':a.action==='status_change'?'mudou o status':a.action==='comment'?'adicionou comentário':a.action==='transfer'?'transferiu lead':a.action==='login'?'fez login':'realizou ação'}
        ${a.lead_name?`no lead <strong>${escHtml(a.lead_name.substring(0,30))}</strong>`:''}
        ${a.detail?`<br><span style="color:var(--text3)">${escHtml(a.detail.substring(0,80))}</span>`:''}
      </div>
      <div class="act-time">${new Date(a.created_at).toLocaleString('pt-BR',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
    </div>`).join('');
}

// ══════════════════════════════════════════════════════
// VIEW TOGGLE (CRM ↔ Admin)
// ══════════════════════════════════════════════════════
function toggleAdminView(){
  viewMode=viewMode==='crm'?'admin':'crm';
  const app=document.getElementById('app');
  const sidebar=document.getElementById('sidebar');
  const main=document.getElementById('main');
  const adminPanel=document.getElementById('admin-panel');
  const btn=document.getElementById('btn-admin-toggle');
  if(viewMode==='admin'){
    app.style.gridTemplateColumns='1fr';
    sidebar.style.display='none';
    main.style.display='none';
    adminPanel.style.display='flex';
    btn.textContent='📋 CRM';
    btn.classList.add('active');
    loadActivityLog();
  }else{
    app.style.gridTemplateColumns='260px 1fr';
    sidebar.style.display='';
    main.style.display='flex';
    adminPanel.style.display='none';
    btn.textContent='🛡 Admin';
    btn.classList.remove('active');
  }
}

// ══════════════════════════════════════════════════════
// TABS / TOAST / SHARED
// ══════════════════════════════════════════════════════
function switchTab(tab,el){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));el.classList.add('active');
  document.getElementById('tab-leads').style.display=tab==='leads'?'block':'none';
  document.getElementById('tab-dashboard').style.display=tab==='dashboard'?'block':'none';
}
function showToast(msg){
  const t=document.createElement('div');t.className='toast';t.textContent=msg;
  document.body.appendChild(t);setTimeout(()=>t.remove(),3000);
}

// START
boot();