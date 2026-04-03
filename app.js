// ── CONFIG ──────────────────────────────────────────────────
let supabase = null;
let currentUser = null, currentProfile = null;
let leads = [], filteredLeads = [];
let currentPage = 1, PER_PAGE = 50;
let currentLead = null, sessionCalls = 0;
let activeStatus = 'all', activeSpecials = new Set(), sortMode = 'default';

// ── INIT SUPABASE ────────────────────────────────────────────
function initSB() {
  supabase = window.supabase.createClient(SUPA_URL, SUPA_KEY);
}

// ── BOOT ─────────────────────────────────────────────────────
async function boot() {
  initSB();
  setLoader('Verificando sessão...', 40);
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { hideLoader(); showLogin(); return; }
  await loadApp(session.user);
}

function setLoader(msg, pct) {
  document.getElementById('loader-msg').textContent = msg;
  if (pct) document.getElementById('loader-fill').style.width = pct + '%';
}
function hideLoader() { document.getElementById('loading-screen').style.display = 'none'; }
function showLogin() { document.getElementById('login-screen').style.display = 'flex'; }

async function loadApp(user) {
  setLoader('Carregando perfil...', 60);
  currentUser = user;
  leads = JSON.parse(JSON.stringify(BASE_LEADS));
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  currentProfile = profile;
  setLoader('Carregando dados...', 80);
  await loadLeadStates();
  await loadCallCount();
  setLoader('Pronto!', 100);
  setTimeout(() => {
    hideLoader();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    if (currentProfile?.role === 'admin') document.getElementById('btn-admin').style.display = '';
    updateUI();
    populateFilters();
    applyFilters();
    renderDashboard();
  }, 300);
}

// ── AUTH ─────────────────────────────────────────────────────
async function doLogin() {
  const email = document.getElementById('l-email').value.trim();
  const pass  = document.getElementById('l-pass').value;
  const btn   = document.getElementById('l-btn');
  const err   = document.getElementById('l-err');
  err.style.display = 'none'; btn.disabled = true; btn.textContent = 'Entrando...';
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: pass });
  if (error) { err.textContent = 'Email ou senha incorretos.'; err.style.display='block'; btn.disabled=false; btn.textContent='Entrar'; return; }
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('loading-screen').style.display = 'flex';
  await loadApp(data.user);
}
async function doLogout() { await supabase.auth.signOut(); location.reload(); }

// ── LEAD STATES ──────────────────────────────────────────────
async function loadLeadStates() {
  const { data } = await supabase.from('lead_states').select('*');
  if (!data) return;
  const map = {};
  data.forEach(s => { map[s.lead_id] = s; });
  leads.forEach(l => {
    const s = map[l.id];
    if (!s) return;
    l.cs = s.cs || 'novo'; l.tg = s.tags || []; l.pr = s.priority || false;
    l.cc = s.call_count || 0; l.lc = s.last_call || null;
    l.cv = s.converted || false; l.cm = s.notes || ''; l.tl = s.timeline || [];
    l.responsible = s.responsible || l.r;
  });
}

async function saveLeadState(lead) {
  setSyncStatus('syncing');
  const { error } = await supabase.from('lead_states').upsert({
    lead_id: lead.id, responsible: lead.responsible || lead.r,
    cs: lead.cs, tags: lead.tg || [], priority: lead.pr || false,
    call_count: lead.cc || 0, last_call: lead.lc || null,
    converted: lead.cv || false, notes: lead.cm || '', timeline: lead.tl || [],
    updated_by: currentUser?.id, updated_at: new Date().toISOString()
  }, { onConflict: 'lead_id' });
  setSyncStatus(error ? 'error' : 'ok');
}

// ── CALL COUNT ───────────────────────────────────────────────
function getWeek() {
  const d = new Date(), day = d.getDay()||7;
  d.setUTCDate(d.getUTCDate()+4-day);
  const ys = new Date(Date.UTC(d.getUTCFullYear(),0,1));
  return `${d.getUTCFullYear()}-W${Math.ceil((((d-ys)/86400000)+1)/7)}`;
}
async function loadCallCount() {
  if (!currentUser) return;
  const { data } = await supabase.from('call_counts').select('calls').eq('user_id', currentUser.id).eq('week_key', getWeek()).single();
  sessionCalls = data?.calls || 0;
  updateProgress();
}
async function saveCallCount() {
  if (!currentUser) return;
  await supabase.from('call_counts').upsert({ user_id: currentUser.id, vendor_name: currentProfile?.name||'', week_key: getWeek(), calls: sessionCalls, updated_at: new Date().toISOString() }, { onConflict: 'user_id,week_key' });
}

// ── ACTIVITY LOG ─────────────────────────────────────────────
async function logActivity(leadId, leadName, action, detail) {
  await supabase.from('activity_log').insert({ user_id: currentUser?.id, user_name: currentProfile?.name||'?', lead_id: leadId, lead_name: leadName, action, detail });
}

// ── SYNC STATUS ──────────────────────────────────────────────
function setSyncStatus(s) {
  const dot = document.getElementById('sync-dot');
  const lbl = document.getElementById('sync-lbl');
  if (!dot) return;
  if (s==='syncing') { dot.className='sync-dot syncing'; lbl.textContent='Salvando...'; }
  else if (s==='ok') { dot.className='sync-dot'; lbl.textContent='Sincronizado'; }
  else { dot.className='sync-dot error'; lbl.textContent='Erro'; }
}

// ── FILTERS ──────────────────────────────────────────────────
function getMyLeads() {
  if (!currentProfile) return leads;
  if (currentProfile.role === 'admin') return leads;
  return leads.filter(l => (l.responsible || l.r) === currentProfile.name);
}

function populateFilters() {
  const pool = getMyLeads();
  const pipes = [...new Set(pool.map(l=>l.p).filter(Boolean))].sort();
  const states = [...new Set(pool.map(l=>l.st).filter(Boolean))].sort();
  const pSel = document.getElementById('filter-pipeline');
  const sSel = document.getElementById('filter-state');
  if (pSel) pipes.forEach(p => { const o=document.createElement('option'); o.value=p; o.textContent=p; pSel.appendChild(o); });
  if (sSel) states.forEach(s => { const o=document.createElement('option'); o.value=s; o.textContent=s; sSel.appendChild(o); });
}

function toggleStatus(el, val) {
  document.querySelectorAll('#status-chips .chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active'); activeStatus=val; currentPage=1; applyFilters();
}
function toggleSpecial(el, val) {
  el.classList.toggle('active');
  activeSpecials.has(val)?activeSpecials.delete(val):activeSpecials.add(val);
  currentPage=1; applyFilters();
}

function applyFilters() {
  const search = document.getElementById('search-input')?.value.toLowerCase() || '';
  const pipeline = document.getElementById('filter-pipeline')?.value || '';
  const type = document.getElementById('filter-type')?.value || '';
  const state = document.getElementById('filter-state')?.value || '';
  const pool = getMyLeads();
  filteredLeads = pool.filter(l => {
    if (activeStatus !== 'all' && l.cs !== activeStatus) return false;
    if (pipeline && l.p !== pipeline) return false;
    if (type && !l.ty.includes(type)) return false;
    if (state && l.st !== state) return false;
    if (activeSpecials.has('priority') && !l.pr) return false;
    if (activeSpecials.has('has_sales') && !l.sl) return false;
    if (activeSpecials.has('has_phone') && !l.ph) return false;
    if (search) { const h=(l.c+' '+l.cn+' '+l.em).toLowerCase(); if (!h.includes(search)) return false; }
    return true;
  });
  if (sortMode==='priority') filteredLeads.sort((a,b)=>(b.pr?1:0)-(a.pr?1:0));
  else if (sortMode==='calls') filteredLeads.sort((a,b)=>b.cc-a.cc);
  else if (sortMode==='company') filteredLeads.sort((a,b)=>a.c.localeCompare(b.c));
  else if (sortMode==='sales') filteredLeads.sort((a,b)=>(b.sl?b.sl.total:0)-(a.sl?a.sl.total:0));
  else filteredLeads.sort((a,b)=>(b.pr?1:0)-(a.pr?1:0));
  currentPage=1; renderTable(); renderPagination(); updateMiniStats(); updateTopbarStats();
}
function sortBy(m) { sortMode=m; applyFilters(); }

// ── TABLE ────────────────────────────────────────────────────
function esc(s) { if(!s)return''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function statusBadge(cs) {
  return {novo:'<span class="badge badge-novo">Novo</span>',contatado:'<span class="badge badge-contatado">Contatado</span>',proposta:'<span class="badge badge-proposta">Proposta</span>',cliente:'<span class="badge badge-cliente">Cliente ✓</span>'}[cs]||'<span class="badge">—</span>';
}

function renderTable() {
  const start=(currentPage-1)*PER_PAGE, page=filteredLeads.slice(start,start+PER_PAGE);
  document.getElementById('lc-shown').textContent=filteredLeads.length.toLocaleString();
  document.getElementById('lc-total').textContent=getMyLeads().length.toLocaleString();
  const tbody=document.getElementById('leads-tbody');
  if (!filteredLeads.length) { tbody.innerHTML='<tr><td colspan="9"><div class="empty-state"><h3>Nenhum lead</h3></div></td></tr>'; return; }
  tbody.innerHTML=page.map(l => {
    const tags=(l.tg||[]).slice(0,2).map(t=>`<span class="tag-pill">${esc(t)}</span>`).join('');
    const hasSales=l.sl?`<span class="has-sales-dot"></span>$${l.sl.total.toFixed(0)}`:'<span style="color:var(--text3)">—</span>';
    const st=l.st?(l.st.split(' - ')[1]||l.st):'—';
    return `<tr class="${l.pr?'priority-row':''}" onclick="openModal(${l.id})">
      <td>${l.pr?'<span class="priority-star">⭐</span>':''}</td>
      <td class="td-company">${esc(l.c)}<small>${esc(l.cn||'—')}</small></td>
      <td style="font-size:11px">${st}</td>
      <td style="font-size:10px;color:var(--text3)">${l.ty?l.ty.split(';')[0]:'—'}</td>
      <td>${statusBadge(l.cs)}</td>
      <td>${tags}</td>
      <td style="text-align:center;color:${l.cc>0?'var(--accent)':'var(--text3)'}">${l.cc}</td>
      <td style="font-size:11px">${hasSales}</td>
      <td><button class="btn btn-ghost" style="padding:4px 10px;font-size:11px" onclick="event.stopPropagation();quickCall(${l.id})">📞</button></td>
    </tr>`;
  }).join('');
}

function renderPagination() {
  const total=Math.ceil(filteredLeads.length/PER_PAGE), pg=document.getElementById('pagination');
  if (total<=1){pg.innerHTML='';return;}
  let h=`<button class="page-btn" onclick="goPage(${currentPage-1})" ${currentPage===1?'disabled':''}>◀</button>`;
  const r=[];for(let i=Math.max(1,currentPage-2);i<=Math.min(total,currentPage+2);i++)r.push(i);
  if(r[0]>1){h+=`<button class="page-btn" onclick="goPage(1)">1</button>`;if(r[0]>2)h+='<span style="color:var(--text3)">…</span>';}
  r.forEach(p=>{h+=`<button class="page-btn ${p===currentPage?'active':''}" onclick="goPage(${p})">${p}</button>`;});
  if(r[r.length-1]<total){if(r[r.length-1]<total-1)h+='<span style="color:var(--text3)">…</span>';h+=`<button class="page-btn" onclick="goPage(${total})">${total}</button>`;}
  h+=`<button class="page-btn" onclick="goPage(${currentPage+1})" ${currentPage===total?'disabled':''}>▶</button>`;
  pg.innerHTML=h;
}
function goPage(p){const t=Math.ceil(filteredLeads.length/PER_PAGE);if(p<1||p>t)return;currentPage=p;renderTable();renderPagination();}

// ── QUICK CALL ───────────────────────────────────────────────
async function quickCall(id) {
  const lead=leads.find(l=>l.id===id);if(!lead)return;
  lead.cc=(lead.cc||0)+1;lead.lc=new Date().toISOString();
  if(lead.cs==='novo')lead.cs='contatado';
  sessionCalls++;applyFilters();updateProgress();
  saveLeadState(lead);saveCallCount();
  logActivity(lead.id,lead.c,'call',`Ligação #${lead.cc}`);
  showToast('📞 '+lead.c.substring(0,25));
}

// ── MODAL ────────────────────────────────────────────────────
function openModal(id) {
  const lead=leads.find(l=>l.id===id);if(!lead)return;
  currentLead=lead;
  document.getElementById('modal-company').textContent=lead.c;
  document.getElementById('modal-sub').textContent=[lead.cn,lead.st?(lead.st.split(' - ')[1]||''):''].filter(Boolean).join(', ')||'—';
  const salesHtml=lead.sl
    ?`<div class="sales-card"><div class="sales-card-val">$${lead.sl.total.toFixed(2)}</div><div class="sales-card-sub">${lead.sl.count} pedidos · Rep: ${lead.sl.rep}</div></div>`
    :'<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;color:var(--text3);font-size:12px">Sem histórico de compras</div>';
  document.getElementById('modal-body').innerHTML=`
    <div class="modal-section"><div class="modal-section-title">Histórico de Vendas</div>${salesHtml}</div>
    <div class="modal-section">
      <div class="modal-section-title">Status</div>
      <div class="status-row" id="modal-status-row">
        ${['novo','contatado','proposta','cliente'].map(s=>`<button class="status-btn ${lead.cs===s?'sel':''}" onclick="setStatus('${s}')">${{novo:'🔵 Novo',contatado:'🟡 Contatado',proposta:'🟣 Proposta',cliente:'🟢 Cliente'}[s]}</button>`).join('')}
      </div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Contato</div>
      <div class="info-grid">
        <div class="info-item"><div class="info-item-lbl">Contato</div><div class="info-item-val">${esc(lead.cn||'—')}</div></div>
        <div class="info-item"><div class="info-item-lbl">Telefone</div><div class="info-item-val">${lead.ph?`<a href="tel:${lead.ph}">${esc(lead.ph)}</a>`:'—'}</div></div>
        <div class="info-item"><div class="info-item-lbl">Email</div><div class="info-item-val">${lead.em?`<a href="mailto:${lead.em}">${esc(lead.em)}</a>`:'—'}</div></div>
        <div class="info-item"><div class="info-item-lbl">Tipo</div><div class="info-item-val">${esc(lead.ty||'—')}</div></div>
        <div class="info-item"><div class="info-item-lbl">Responsável</div><div class="info-item-val">${esc(lead.responsible||lead.r||'—')}</div></div>
        <div class="info-item"><div class="info-item-lbl">Pipeline</div><div class="info-item-val" style="font-size:11px">${esc(lead.p||'—')}</div></div>
        ${lead.ig?`<div class="info-item"><div class="info-item-lbl">Instagram</div><div class="info-item-val"><a href="${esc(lead.ig)}" target="_blank">Ver ↗</a></div></div>`:''}
        ${lead.wb?`<div class="info-item"><div class="info-item-lbl">Website</div><div class="info-item-val"><a href="${esc(lead.wb)}" target="_blank">Abrir ↗</a></div></div>`:''}
      </div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Prioridade</div>
      <label class="priority-toggle"><input type="checkbox" id="modal-priority" ${lead.pr?'checked':''} onchange="currentLead.pr=this.checked"><span>Marcar como prioridade ⭐</span></label>
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
      <textarea class="modal-textarea" id="modal-comments" placeholder="Notas gerais...">${esc(lead.cm||'')}</textarea>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Ligações</div>
      <div class="call-log">📞 Total: <strong style="color:var(--accent)">${lead.cc||0}</strong>${lead.lc?` · Última: <strong>${new Date(lead.lc).toLocaleString('pt-BR')}</strong>`:' · Nenhuma'}</div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Timeline de Comentários</div>
      <div class="tl-add">
        <textarea id="tl-new-text" placeholder="Adicionar comentário..."></textarea>
        <button class="btn btn-primary" style="height:60px;white-space:nowrap" onclick="addTimelineEntry()">+ Adicionar</button>
      </div>
      <div style="margin-top:12px" id="timeline-list"></div>
    </div>`;
  renderTagsDisplay(); renderTimeline();
  document.getElementById('modal-footer').innerHTML=`
    <button class="btn btn-danger" id="btn-undo" onclick="undoCall()" ${(lead.cc||0)===0?'disabled style="opacity:.3"':''}>↩ Desfazer</button>
    <button class="btn btn-ghost" onclick="registerCall()">📞 Registrar</button>
    <button class="btn btn-primary" onclick="saveModal()">💾 Salvar</button>`;
  document.getElementById('modal').style.display='flex';
}

function renderTagsDisplay(){const el=document.getElementById('tags-display');if(!el||!currentLead)return;el.innerHTML=(currentLead.tg||[]).map((t,i)=>`<span class="tag-rm">${esc(t)}<button onclick="removeTag(${i})">×</button></span>`).join('');}
function renderTimeline(){const el=document.getElementById('timeline-list');if(!el||!currentLead)return;const e=currentLead.tl||[];if(!e.length){el.innerHTML='<div class="tl-empty">Nenhum comentário.</div>';return;}el.innerHTML='<div class="timeline">'+[...e].reverse().map(x=>`<div class="tl-entry"><div class="tl-dot"></div><div class="tl-body"><div class="tl-meta"><span class="tl-vendor">👤 ${esc(x.v||'—')}</span><span class="tl-date">${new Date(x.ts).toLocaleString('pt-BR')}</span></div><div class="tl-text">${esc(x.txt)}</div></div></div>`).join('')+'</div>';}
function addTimelineEntry(){if(!currentLead)return;const inp=document.getElementById('tl-new-text'),txt=inp.value.trim();if(!txt){showToast('⚠️ Digite um comentário');return;}if(!currentLead.tl)currentLead.tl=[];currentLead.tl.push({ts:new Date().toISOString(),v:currentProfile?.name||'—',txt});inp.value='';renderTimeline();logActivity(currentLead.id,currentLead.c,'comment',txt.substring(0,80));showToast('💬 Adicionado!');}
function addTag(){const inp=document.getElementById('tag-input');if(!inp||!currentLead)return;const val=inp.value.trim();if(!val)return;if(!currentLead.tg)currentLead.tg=[];if(!currentLead.tg.includes(val))currentLead.tg.push(val);inp.value='';renderTagsDisplay();}
function addTagQuick(tag){if(!currentLead)return;if(!currentLead.tg)currentLead.tg=[];if(!currentLead.tg.includes(tag))currentLead.tg.push(tag);renderTagsDisplay();}
function removeTag(i){if(currentLead){currentLead.tg.splice(i,1);renderTagsDisplay();}}
function setStatus(s){if(!currentLead)return;const old=currentLead.cs;currentLead.cs=s;if(s==='cliente'){currentLead.cv=true;currentLead.lc=new Date().toISOString();}document.querySelectorAll('#modal-status-row .status-btn').forEach(b=>b.classList.toggle('sel',b.getAttribute('onclick').includes("'"+s+"'")));if(old!==s)logActivity(currentLead.id,currentLead.c,'status_change',`${old} → ${s}`);}
function updateCallLog(){const cl=document.querySelector('.call-log');if(!cl||!currentLead)return;cl.innerHTML=`📞 Total: <strong style="color:var(--accent)">${currentLead.cc}</strong>`+(currentLead.lc?` · Última: <strong>${new Date(currentLead.lc).toLocaleString('pt-BR')}</strong>`:' · Nenhuma');const btn=document.getElementById('btn-undo');if(btn){btn.disabled=!currentLead.cc;btn.style.opacity=currentLead.cc?'1':'0.3';}}
async function registerCall(){if(!currentLead)return;currentLead.cc=(currentLead.cc||0)+1;currentLead.lc=new Date().toISOString();if(currentLead.cs==='novo')currentLead.cs='contatado';sessionCalls++;updateCallLog();updateProgress();saveCallCount();logActivity(currentLead.id,currentLead.c,'call',`Ligação #${currentLead.cc}`);showToast('📞 Registrada!');}
async function undoCall(){if(!currentLead||!currentLead.cc)return;currentLead.cc--;if(!currentLead.cc)currentLead.lc=null;if(sessionCalls>0)sessionCalls--;updateCallLog();updateProgress();saveCallCount();showToast('↩ Desfeita');}
async function saveModal(){if(!currentLead)return;const cm=document.getElementById('modal-comments');if(cm)currentLead.cm=cm.value;await saveLeadState(currentLead);closeModal();applyFilters();showToast('✅ Salvo!');}
function closeModal(){document.getElementById('modal').style.display='none';currentLead=null;}
function closeModalOutside(e){if(e.target===document.getElementById('modal'))closeModal();}

// ── STATS ────────────────────────────────────────────────────
function updateUI(){document.getElementById('user-name').textContent=currentProfile?.name||currentUser?.email||'—';document.getElementById('user-role').textContent=currentProfile?.role==='admin'?'Admin':'Vendedor';}
function updateTopbarStats(){document.getElementById('ts-total').textContent=filteredLeads.length.toLocaleString();document.getElementById('ts-calls').textContent=sessionCalls;document.getElementById('ts-conv').textContent=leads.filter(l=>l.cs==='cliente').length;document.getElementById('ts-priority').textContent=leads.filter(l=>l.pr).length;}
function updateProgress(){const pct=Math.min(100,(sessionCalls/250)*100);document.getElementById('prog-fill').style.width=pct+'%';document.getElementById('calls-done').textContent=sessionCalls+' ligações';document.getElementById('ts-calls').textContent=sessionCalls;}
function updateMiniStats(){document.getElementById('mini-shown').textContent=filteredLeads.length;document.getElementById('mini-priority').textContent=filteredLeads.filter(l=>l.pr).length;document.getElementById('mini-clients').textContent=filteredLeads.filter(l=>l.cs==='cliente').length;document.getElementById('mini-calls').textContent=filteredLeads.reduce((s,l)=>s+(l.cc||0),0);}

// ── DASHBOARD ────────────────────────────────────────────────
function renderDashboard(){
  const s=SALES_DATA.summary, pool=getMyLeads();
  const withPhone=pool.filter(l=>l.ph).length,withSales=pool.filter(l=>l.sl).length;
  document.getElementById('kpi-grid').innerHTML=`
    <div class="kpi-card green"><div class="kpi-card-val">$${(s.total_revenue/1000).toFixed(0)}K</div><div class="kpi-card-lbl">Receita Março</div></div>
    <div class="kpi-card blue"><div class="kpi-card-val">${s.total_orders.toLocaleString()}</div><div class="kpi-card-lbl">Pedidos</div></div>
    <div class="kpi-card yellow"><div class="kpi-card-val">${pool.length.toLocaleString()}</div><div class="kpi-card-lbl">Meus Leads</div></div>
    <div class="kpi-card purple"><div class="kpi-card-val">${withSales}</div><div class="kpi-card-lbl">c/ Compras</div></div>
    <div class="kpi-card green"><div class="kpi-card-val">${withPhone.toLocaleString()}</div><div class="kpi-card-lbl">Com Telefone</div></div>`;
  const topReps=SALES_DATA.top_reps.slice(0,6),maxRep=topReps[0][1];
  const byPipe={};pool.forEach(l=>{byPipe[l.p]=(byPipe[l.p]||0)+1;});
  const pipeE=Object.entries(byPipe).sort((a,b)=>b[1]-a[1]),maxPipe=pipeE[0]?.[1]||1;
  document.getElementById('charts-row').innerHTML=`
    <div class="chart-card"><div class="chart-title">💰 Receita por Vendedor</div><div class="bar-chart">${topReps.map(([r,v])=>`<div class="bar-row"><div class="bar-label">${r}</div><div class="bar-track"><div class="bar-fill" style="width:${(v/maxRep*100).toFixed(0)}%"></div></div><div class="bar-val">$${(v/1000).toFixed(0)}K</div></div>`).join('')}</div></div>
    <div class="chart-card"><div class="chart-title">📊 Pipeline</div><div class="bar-chart">${pipeE.slice(0,6).map(([p,v])=>`<div class="bar-row"><div class="bar-label">${p}</div><div class="bar-track"><div class="bar-fill" style="width:${(v/maxPipe*100).toFixed(0)}%;background:linear-gradient(90deg,#a78bfa,#c4b5fd)"></div></div><div class="bar-val">${v}</div></div>`).join('')}</div></div>`;
}

// ── ADMIN ────────────────────────────────────────────────────
let allUsers = [], kanbanData = {}, draggingId = null;
function toggleAdminView(){
  const isAdmin = document.getElementById('admin-panel').style.display !== 'flex';
  document.getElementById('main').style.display = isAdmin ? 'none' : 'flex';
  document.getElementById('sidebar').style.display = isAdmin ? 'none' : '';
  document.getElementById('admin-panel').style.display = isAdmin ? 'flex' : 'none';
  document.getElementById('btn-admin').textContent = isAdmin ? '📋 CRM' : '🛡 Admin';
  if (isAdmin) { loadAllUsers(); }
}
async function loadAllUsers(){
  const {data}=await supabase.from('profiles').select('*').order('name');
  allUsers=data||[];renderUsersTable();loadKanban();loadActivityLog();
}
function renderUsersTable(){
  const tbody=document.getElementById('users-tbody');if(!tbody)return;
  const leadsPerUser={};leads.forEach(l=>{const r=l.responsible||l.r;if(r)leadsPerUser[r]=(leadsPerUser[r]||0)+1;});
  tbody.innerHTML=allUsers.map(u=>`<tr><td style="font-weight:500">${esc(u.name)}</td><td><span class="role-badge ${u.role==='admin'?'role-admin':'role-vendor'}">${u.role}</span></td><td style="color:var(--accent);font-weight:600">${leadsPerUser[u.name]||0}</td></tr>`).join('');
}
function loadKanban(){
  kanbanData={};
  allUsers.filter(u=>u.role==='vendor').forEach(u=>{kanbanData[u.name]=leads.filter(l=>(l.responsible||l.r)===u.name).slice(0,15);});
  const unassigned=leads.filter(l=>{const r=l.responsible||l.r;return !r||!allUsers.find(u=>u.name===r);}).slice(0,15);
  if(unassigned.length)kanbanData['Não atribuído']=unassigned;
  renderKanban();
}
function renderKanban(){
  const wrap=document.getElementById('kanban-wrap');if(!wrap)return;
  wrap.innerHTML=Object.entries(kanbanData).map(([vendor,vl])=>`
    <div class="kanban-col" data-vendor="${esc(vendor)}">
      <div class="kanban-col-header">${esc(vendor)}<span>${vl.length}${vl.length>=15?'+':''}</span></div>
      <div class="kanban-col-body" ondragover="onDragOver(event)" ondrop="onDrop(event,'${esc(vendor)}')" ondragleave="onDragLeave(event)">
        ${vl.map(l=>`<div class="kanban-card" draggable="true" data-id="${l.id}" ondragstart="onDragStart(event,${l.id})"><div class="kanban-card-name">${esc(l.c)}</div><div class="kanban-card-state">${{novo:'🔵',contatado:'🟡',proposta:'🟣',cliente:'🟢'}[l.cs]||'⚪'} ${l.cs}</div></div>`).join('')}
      </div>
    </div>`).join('');
}
function onDragStart(e,id){draggingId=id;e.currentTarget.classList.add('dragging');e.dataTransfer.effectAllowed='move';}
function onDragOver(e){e.preventDefault();e.currentTarget.classList.add('drag-over');}
function onDragLeave(e){e.currentTarget.classList.remove('drag-over');}
async function onDrop(e,vendor){
  e.preventDefault();e.currentTarget.classList.remove('drag-over');
  if(!draggingId)return;
  const lead=leads.find(l=>l.id===draggingId);if(!lead)return;
  const old=lead.responsible||lead.r;lead.responsible=vendor;
  Object.keys(kanbanData).forEach(v=>{kanbanData[v]=kanbanData[v].filter(l=>l.id!==draggingId);});
  if(!kanbanData[vendor])kanbanData[vendor]=[];kanbanData[vendor].push(lead);
  renderKanban();await saveLeadState(lead);
  logActivity(lead.id,lead.c,'transfer',`${old} → ${vendor}`);
  showToast(`✅ "${lead.c.substring(0,20)}" → ${vendor}`);draggingId=null;
}
async function loadActivityLog(){
  const el=document.getElementById('activity-list');if(!el)return;
  const {data}=await supabase.from('activity_log').select('*').order('created_at',{ascending:false}).limit(50);
  if(!data||!data.length){el.innerHTML='<div style="color:var(--text3);padding:20px;text-align:center">Nenhuma atividade ainda</div>';return;}
  const icons={call:'📞',status_change:'🔄',comment:'💬',transfer:'🔀',login:'🔑'};
  el.innerHTML=data.map(a=>`<div class="activity-item"><div class="act-icon">${icons[a.action]||'📝'}</div><div class="act-body"><strong>${esc(a.user_name||'—')}</strong> ${a.action==='call'?'ligou':a.action==='transfer'?'transferiu':a.action==='comment'?'comentou':a.action==='status_change'?'mudou status':'ação'} ${a.lead_name?`em <strong>${esc(a.lead_name.substring(0,25))}</strong>`:''} ${a.detail?`<br><span style="color:var(--text3)">${esc(a.detail.substring(0,60))}</span>`:''}</div><div class="act-time">${new Date(a.created_at).toLocaleString('pt-BR',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div></div>`).join('');
}
async function createUser(){
  const name=document.getElementById('new-name').value.trim(),email=document.getElementById('new-email').value.trim(),pass=document.getElementById('new-pass').value,role=document.getElementById('new-role').value;
  if(!name||!email||!pass){showToast('⚠️ Preencha todos os campos');return;}
  const {data,error}=await supabase.auth.signUp({email,password:pass});
  if(error){showToast('❌ '+error.message);return;}
  if(data.user){await supabase.from('profiles').insert({id:data.user.id,name,role});}
  showToast('✅ Usuário criado!');await loadAllUsers();
}

// ── TABS / TOAST ─────────────────────────────────────────────
function switchTab(tab,el){document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));el.classList.add('active');document.getElementById('tab-leads').style.display=tab==='leads'?'block':'none';document.getElementById('tab-dashboard').style.display=tab==='dashboard'?'block':'none';}
function showToast(msg){const t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),3000);}

// ── START ────────────────────────────────────────────────────
window.addEventListener('load', boot);