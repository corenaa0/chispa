'use strict';
/*
 * Panel de administración de Chispa.
 * Inicia sesión con Supabase Auth; solo los correos de la tabla `admins` pueden ver los datos
 * (lo garantizan las reglas de seguridad de supabase.sql, no este archivo).
 * Todo el texto que viene de usuarios se pinta con textContent para evitar inyección de código.
 */

const cfg = window.CHISPA_CONFIG || {};
const $ = (s) => document.querySelector(s);
const sb = cfg.supabaseUrl && cfg.supabaseKey && window.supabase
  ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey)
  : null;

const views = ['viewSetup', 'viewLogin', 'viewNoAdmin', 'viewPanel'];
const state = { bans: [], reports: [], tab: 'reports', banCtx: null, refreshTimer: null };

/* ---------- Utilidades ---------- */
function show(view) {
  views.forEach((v) => $(`#${v}`).classList.toggle('hidden', v !== view));
}

function toast(text, ms = 3000) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

function h(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

const fmtDate = (d) => (d ? new Date(d).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : '');
const shortId = (s) => (s ? `${String(s).slice(0, 8)}…` : '—');
function shortUA(ua) {
  if (!ua) return '—';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' · ') || ua.slice(0, 30);
}
const isActiveBan = (b) => !b.expires_at || new Date(b.expires_at) > new Date();
const isBanned = (kind, value) => !!value && state.bans.some((b) => b.kind === kind && b.value === value && isActiveBan(b));
const safeImage = (src) => (typeof src === 'string' && src.startsWith('data:image/jpeg;base64,') ? src : null);

function failed(error, what) {
  if (!error) return false;
  console.error(what, error);
  toast(`Error al ${what}: ${error.message || error}`, 5000);
  return true;
}

/* ---------- Sesión ---------- */
async function init() {
  if (!sb) { show('viewSetup'); return; }
  const { data } = await sb.auth.getSession();
  if (data.session) await enterPanel(data.session);
  else show('viewLogin');
}

$('#formLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#btnLogin');
  btn.disabled = true; btn.textContent = 'Entrando…';
  $('#loginError').classList.add('hidden');
  const { data, error } = await sb.auth.signInWithPassword({ email: $('#inEmail').value.trim(), password: $('#inPass').value });
  btn.disabled = false; btn.textContent = 'Entrar';
  if (error) {
    $('#loginError').textContent = 'Correo o contraseña incorrectos.';
    $('#loginError').classList.remove('hidden');
    return;
  }
  $('#inPass').value = '';
  await enterPanel(data.session);
});

document.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', async () => {
  await sb.auth.signOut();
  location.reload();
}));

async function enterPanel(session) {
  const email = session.user.email;
  const { data: isAdmin, error } = await sb.rpc('is_admin');
  if (error || !isAdmin) {
    $('#noAdminEmail').textContent = email;
    show('viewNoAdmin');
    return;
  }
  $('#userEmail').textContent = email;
  show('viewPanel');
  await refreshAll();
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => { if (!document.querySelector('dialog[open]')) refreshAll(true); }, 30000);
}

/* ---------- Carga de datos ---------- */
async function refreshAll(quiet) {
  await loadBans();
  await Promise.all([loadReports(), loadKpis(), state.tab === 'visits' ? loadVisits() : null]);
  if (!quiet) toast('Datos actualizados');
}

async function loadKpis() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const [pending, today] = await Promise.all([
    sb.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'pendiente'),
    sb.from('visits').select('ip').gte('created_at', start.toISOString()).limit(5000),
  ]);
  $('#kpiPending').textContent = pending.count ?? '–';
  $('#badgeReports').textContent = pending.count ? String(pending.count) : '';
  const rows = today.data || [];
  $('#kpiToday').textContent = rows.length;
  $('#kpiIps').textContent = new Set(rows.map((r) => r.ip)).size;
  $('#kpiBans').textContent = state.bans.filter(isActiveBan).length;
}

async function loadBans() {
  const { data, error } = await sb.from('bans').select('*').order('created_at', { ascending: false }).limit(500);
  if (failed(error, 'cargar bloqueos')) return;
  state.bans = data || [];
  renderBans();
}

async function loadReports() {
  const status = $('#selStatus').value;
  let q = sb.from('reports').select('*').order('created_at', { ascending: false }).limit(100);
  if (status !== 'todos') q = q.eq('status', status);
  const { data, error } = await q;
  if (failed(error, 'cargar reportes')) return;
  state.reports = data || [];
  renderReports();
}

async function loadVisits() {
  const term = $('#inSearch').value.trim().replace(/[^\p{L}\p{N}.:\- ]/gu, '').slice(0, 40);
  let q = sb.from('visits').select('*').order('created_at', { ascending: false }).limit(300);
  if (term) q = q.or(`name.ilike.%${term}%,ip.ilike.%${term}%,sala.ilike.%${term}%`);
  const { data, error } = await q;
  if (failed(error, 'cargar conexiones')) return;
  renderVisits(data || []);
}

/* ---------- Reportes ---------- */
function renderReports() {
  const list = $('#reportList');
  list.replaceChildren();
  if (!state.reports.length) {
    list.append(h('p', { class: 'empty', text: 'No hay reportes en esta vista. 🎉' }));
    return;
  }
  const countByIp = {};
  state.reports.forEach((r) => { if (r.reported_ip) countByIp[r.reported_ip] = (countByIp[r.reported_ip] || 0) + 1; });

  for (const r of state.reports) {
    const img = safeImage(r.image);
    const shot = img
      ? h('img', { class: 'report-shot', src: img, alt: 'Captura del reporte', onclick: () => openImage(img) })
      : h('div', { class: 'report-noshot', text: 'Sin captura' });

    const ipBanned = isBanned('ip', r.reported_ip);
    const devBanned = isBanned('device', r.reported_device);
    const head = h('div', { class: 'report-head' },
      h('span', { class: 'pill reason', text: r.reason || 'Sin motivo' }),
      h('span', { class: `pill ${r.status}`, text: r.status }),
      (ipBanned || devBanned) ? h('span', { class: 'pill banned', text: 'Bloqueado' }) : null,
      h('span', { class: 'report-date', text: fmtDate(r.created_at) }));

    const repeats = r.reported_ip && countByIp[r.reported_ip] > 1 ? ` (${countByIp[r.reported_ip]} reportes en esta lista)` : '';
    const kv = h('dl', { class: 'kv' },
      h('dt', { text: 'Reportado' }), h('dd', {}, h('b', { text: r.reported_name || '—' })),
      h('dt', { text: 'IP' }), h('dd', { class: 'mono', text: (r.reported_ip || 'desconocida') + repeats }),
      h('dt', { text: 'Dispositivo' }), h('dd', { class: 'mono', text: shortId(r.reported_device), title: r.reported_device || '' }),
      h('dt', { text: 'Sala' }), h('dd', { text: r.sala || '—' }),
      h('dt', { text: 'Reportó' }), h('dd', { text: `${r.reporter_name || '—'} · ${r.reporter_ip || '—'}` }));

    const body = h('div', { class: 'report-body' }, head, kv,
      r.details ? h('div', { class: 'report-details', text: r.details }) : null);

    const actions = h('div', { class: 'report-actions' },
      h('button', {
        class: 'btn danger-solid', type: 'button', disabled: !r.reported_ip || ipBanned,
        text: ipBanned ? 'IP bloqueada' : '⛔ Banear IP',
        onclick: () => openBan('ip', r.reported_ip, r.reason, r),
      }),
      h('button', {
        class: 'btn', type: 'button', disabled: !r.reported_device || devBanned,
        text: devBanned ? 'Dispositivo bloqueado' : '📱 Banear dispositivo',
        onclick: () => openBan('device', r.reported_device, r.reason, r),
      }),
      r.status !== 'resuelto' ? h('button', { class: 'btn', type: 'button', text: '✓ Resuelto', onclick: () => setStatus(r.id, 'resuelto') }) : null,
      r.status !== 'descartado' ? h('button', { class: 'btn ghost', type: 'button', text: 'Descartar', onclick: () => setStatus(r.id, 'descartado') }) : null,
      h('button', { class: 'btn ghost', type: 'button', text: '🗑', title: 'Eliminar reporte', onclick: () => deleteReport(r.id) }));

    list.append(h('article', { class: `report ${r.status}` }, shot, body, actions));
  }
}

async function setStatus(id, status) {
  const { error } = await sb.from('reports').update({ status }).eq('id', id);
  if (failed(error, 'actualizar el reporte')) return;
  toast(status === 'resuelto' ? 'Reporte marcado como resuelto' : 'Reporte descartado');
  await Promise.all([loadReports(), loadKpis()]);
}

async function deleteReport(id) {
  if (!confirm('¿Eliminar este reporte y su captura? No se puede deshacer.')) return;
  const { error } = await sb.from('reports').delete().eq('id', id);
  if (failed(error, 'eliminar el reporte')) return;
  toast('Reporte eliminado');
  await Promise.all([loadReports(), loadKpis()]);
}

function openImage(src) {
  $('#bigImage').src = src;
  $('#dlgImage').showModal();
}

/* ---------- Bloqueos ---------- */
async function openBan(kind, value, reason, report) {
  state.banCtx = { kind, report };
  $('#banKindLabel').textContent = kind === 'ip' ? 'IP' : 'dispositivo';
  $('#banValue').value = value || '';
  $('#banValue').readOnly = !!value;
  $('#banReason').value = reason || '';
  $('#banDuration').value = '24';
  $('#banShared').classList.add('hidden');
  $('#dlgBan').showModal();

  // Aviso: una IP compartida (Wi-Fi del colegio) puede bloquear a muchas personas.
  if (kind === 'ip' && value) {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const { data } = await sb.from('visits').select('name, device').eq('ip', value).gte('created_at', since).limit(1000);
    const devices = new Set((data || []).map((v) => v.device).filter(Boolean));
    if (devices.size > 1) {
      $('#banShared').textContent = `⚠️ Esta IP la usaron ${devices.size} dispositivos distintos en los últimos 7 días. Puede ser una red compartida (Wi-Fi del colegio o de una casa): bloquearla dejaría fuera a todos. Considera bloquear solo el dispositivo.`;
      $('#banShared').classList.remove('hidden');
    }
  }
}

$('#formBan').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ctx = state.banCtx;
  if (!ctx) return;
  const value = $('#banValue').value.trim();
  if (!value) return;
  const hours = Number($('#banDuration').value);
  const row = {
    kind: ctx.kind,
    value,
    reason: $('#banReason').value.trim() || null,
    expires_at: hours ? new Date(Date.now() + hours * 3600e3).toISOString() : null,
  };
  const { error } = await sb.from('bans').upsert(row, { onConflict: 'kind,value' });
  if (failed(error, 'bloquear')) return;
  if (ctx.report && ctx.report.status === 'pendiente') {
    await sb.from('reports').update({ status: 'resuelto' }).eq('id', ctx.report.id);
  }
  $('#dlgBan').close();
  toast(`${ctx.kind === 'ip' ? 'IP' : 'Dispositivo'} bloqueado ✅`);
  await refreshAll(true);
});

function renderBans() {
  const tbody = $('#banRows');
  tbody.replaceChildren();
  if (!state.bans.length) {
    tbody.append(h('tr', {}, h('td', { colspan: '6', class: 'empty', text: 'No hay bloqueos.' })));
    return;
  }
  for (const b of state.bans) {
    const active = isActiveBan(b);
    tbody.append(h('tr', {},
      h('td', { text: b.kind === 'ip' ? 'IP' : 'Dispositivo' }),
      h('td', { class: 'mono', text: b.kind === 'ip' ? b.value : shortId(b.value), title: b.value }),
      h('td', { class: 'wrap', text: b.reason || '—' }),
      h('td', { text: fmtDate(b.created_at) }),
      h('td', { text: b.expires_at ? `${fmtDate(b.expires_at)}${active ? '' : ' (vencido)'}` : 'Permanente' }),
      h('td', {}, h('button', { class: 'btn', type: 'button', text: 'Quitar bloqueo', onclick: () => unban(b.id) }))));
  }
}

async function unban(id) {
  if (!confirm('¿Quitar este bloqueo?')) return;
  const { error } = await sb.from('bans').delete().eq('id', id);
  if (failed(error, 'quitar el bloqueo')) return;
  toast('Bloqueo quitado');
  await refreshAll(true);
}

$('#btnManualBan').addEventListener('click', () => openBan('ip', '', '', null));

/* ---------- Conexiones ---------- */
function renderVisits(rows) {
  const tbody = $('#visitRows');
  tbody.replaceChildren();
  if (!rows.length) {
    tbody.append(h('tr', {}, h('td', { colspan: '7', class: 'empty', text: 'Sin resultados.' })));
    return;
  }
  for (const v of rows) {
    const ipB = isBanned('ip', v.ip);
    const devB = isBanned('device', v.device);
    tbody.append(h('tr', {},
      h('td', { text: fmtDate(v.created_at) }),
      h('td', { class: 'wrap', text: v.name || '—' }),
      h('td', { text: v.sala || '—' }),
      h('td', { class: 'mono', text: v.ip || '—' }),
      h('td', { class: 'mono', text: shortId(v.device), title: v.device || '' }),
      h('td', { text: shortUA(v.user_agent), title: v.user_agent || '' }),
      h('td', {},
        h('button', { class: 'btn', type: 'button', disabled: !v.ip || ipB, text: ipB ? 'IP bloqueada' : 'Banear IP', onclick: () => openBan('ip', v.ip, '', null) }),
        ' ',
        h('button', { class: 'btn ghost', type: 'button', disabled: !v.device || devB, text: devB ? 'Disp. bloqueado' : 'Banear disp.', onclick: () => openBan('device', v.device, '', null) }))));
  }
}

$('#btnSearch').addEventListener('click', loadVisits);
$('#inSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadVisits(); });
$('#btnPurge').addEventListener('click', async () => {
  if (!confirm('¿Borrar los registros de conexión de hace más de 30 días? No se puede deshacer.')) return;
  const { data, error } = await sb.rpc('purge_old_visits', { p_days: 30 });
  if (failed(error, 'borrar registros')) return;
  toast(`Se borraron ${data} registros antiguos`);
  await loadVisits();
});

/* ---------- Pestañas y diálogos ---------- */
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  state.tab = t.dataset.tab;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
  $('#tabReports').classList.toggle('hidden', state.tab !== 'reports');
  $('#tabVisits').classList.toggle('hidden', state.tab !== 'visits');
  $('#tabBans').classList.toggle('hidden', state.tab !== 'bans');
  if (state.tab === 'visits') loadVisits();
}));
$('#selStatus').addEventListener('change', loadReports);
$('#btnRefresh').addEventListener('click', () => refreshAll());
document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

init();
