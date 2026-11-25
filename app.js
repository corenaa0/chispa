'use strict';
/*
 * Chispa — videochat aleatorio por salas, 1 a 1 o en grupos de hasta 8.
 *
 * Cómo funciona (sin servidor propio):
 *  - Cada navegador crea un "peer" con PeerJS (usa el servidor público gratuito de PeerJS
 *    solo para presentarse; el video y el chat viajan directo entre navegadores por WebRTC,
 *    o por el TURN configurado en config.js cuando la red no permite conexión directa).
 *  - Por cada sala existe un "anfitrión": el primer navegador que logra reservar el ID
 *    `chispa-v2-<sala>`. Ese navegador hace de emparejador (lobby): sabe quién busca, con
 *    cuántas personas quiere hablar (2 a 8) y arma los grupos con quienes eligieron lo mismo.
 *  - Los grupos empiezan con 2 personas y se van llenando a medida que llegan más.
 *  - En un grupo todos se conectan con todos (malla): el que llega llama a los que ya estaban.
 *  - Si el anfitrión se va, los demás compiten por reservar el ID y uno nuevo toma el relevo.
 */

const PREFIX = 'chispa-v4-';
const MIN_SIZE = 2;
const MAX_SIZE = 8;
// Si tras estos ms no hay gente con tu mismo número, te unimos a un grupo más pequeño.
const FALLBACK_MS = 5000;
const STUN_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const PEER_OPTS = {
  debug: 1,
  config: { iceServers: [...STUN_SERVERS] },
};
const NETWORK_TIP = 'Tu red podría estar bloqueando la conexión. Prueba con otra red (Wi-Fi ↔ datos móviles) y abre el enlace en Chrome o Safari, no dentro de WhatsApp o Instagram.';
const EMOJIS = ['👋', '😂', '❤️', '🔥', '👏', '😡'];
// Límites anti-spam.
const MAX_MSG = 200;          // caracteres por mensaje
const MSG_COOLDOWN = 3000;    // espera entre mensajes (ms)
const GAME_COOLDOWN = 15000;  // espera entre tarjetas de juego (ms), compartida por los 3 juegos

// Juegos del chat: cada botón manda una tarjeta al azar a todo el grupo (las frases están en retos.js).
const JUEGOS = window.CHISPA_JUEGOS || { ROMPEHIELOS: [], RETOS: [], PREFIERES: [] };
const GAMES = {
  ice: { icon: '🎲', title: 'Rompehielos', list: JUEGOS.ROMPEHIELOS, bag: [] },
  reto: { icon: '🎯', title: 'Reto', list: JUEGOS.RETOS, bag: [] },
  prefiere: { icon: '🤔', title: '¿Qué prefieres?', list: JUEGOS.PREFIERES, bag: [] },
};

// Saca una tarjeta al azar sin repetir hasta haber usado todas (bolsa barajada).
function drawCard(game) {
  if (!game.bag.length) {
    game.bag = game.list.map((_, i) => i);
    for (let i = game.bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [game.bag[i], game.bag[j]] = [game.bag[j], game.bag[i]];
    }
  }
  return game.bag.pop();
}

const $ = (s) => document.querySelector(s);
const el = {
  inicio: $('#inicio'), app: $('#app'), form: $('#formInicio'),
  inName: $('#inName'), inSala: $('#inSala'), inIntereses: $('#inIntereses'),
  inSoloTexto: $('#inSoloTexto'), verNormas: $('#verNormas'),
  sizePicker: $('#sizePicker'), sizeHint: $('#sizeHint'), selSize: $('#selSize'),
  lblSala: $('#lblSala'), lblLobby: $('#lblLobby'), lobbyDot: $('#lobbyDot'),
  videos: $('#videos'), tiles: $('#tiles'), localVideo: $('#localVideo'),
  overlay: $('#overlay'), overlayText: $('#overlayText'), overlaySub: $('#overlaySub'), spinner: $('#spinner'),
  groupTag: $('#groupTag'), groupLabel: $('#groupLabel'), timer: $('#timer'),
  btnNext: $('#btnNext'), btnStop: $('#btnStop'), btnMic: $('#btnMic'), btnCam: $('#btnCam'),
  btnFlip: $('#btnFlip'), btnShare: $('#btnShare'),
  inAuto: $('#inAuto'), quick: $('#quick'),
  log: $('#log'), typing: $('#typing'), formChat: $('#formChat'), inMsg: $('#inMsg'), btnSend: $('#btnSend'),
  msgCounter: $('#msgCounter'),
  reactLocal: $('#reactLocal'),
  dlgShare: $('#dlgShare'), dlgNormas: $('#dlgNormas'), shareLink: $('#shareLink'), shareSala: $('#shareSala'),
  qr: $('#qr'), btnCopy: $('#btnCopy'), btnNativeShare: $('#btnNativeShare'), toast: $('#toast'),
};

const state = {
  name: '', sala: '', interests: [], size: 2,
  me: null, meOpened: false,
  lobbyPeer: null, lobby: null, lobbyConn: null, pendingLobby: null, lobbySend: null, lastLobbyMsg: 0,
  lobbyFails: 0, warnedNetwork: false, failPendingLobby: null,
  stats: { online: 0, waiting: 0, chatting: 0, sizes: {} },
  audioCtx: null, localStream: null, hasCamera: false, hasMic: false, camOn: true, micOn: true, facing: 'user',
  hasTurn: false,
  group: null, // { gid, size, peers: Map<id, peer>, startedAt }
  searching: false, lastTypingSent: 0,
  earlyCalls: new Map(), earlyConns: new Map(),
  blocked: new Set(),
  timers: {},
};

/* ================= Utilidades ================= */
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
function slug(v) {
  const s = String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return s || 'general';
}
const parseInterests = (v) => [...new Set(String(v || '').split(',').map((x) => clean(x, 20).toLowerCase()).filter(Boolean))].slice(0, 8);
const commonInterests = (a, b) => { const sb = new Set(b); return a.filter((x) => sb.has(x)); };
const clampSize = (v) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, parseInt(v, 10) || MIN_SIZE));
const sizeLabel = (n) => (n === 2 ? '1 a 1' : `grupo de ${n}`);
const safe = (fn) => { try { return fn(); } catch (e) { console.warn(e); } };
const storeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const storeSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };
const lobbyId = () => PREFIX + state.sala;
const PUBLIC_ROOM = 'general';
const isPublicRoom = () => state.sala === PUBLIC_ROOM;
const roomLabel = () => (isPublicRoom() ? '🌎 Sala pública' : `#${state.sala}`);
const getPeer = (id) => (state.group ? state.group.peers.get(id) : undefined);
const connectedPeers = () => (state.group ? [...state.group.peers.values()].filter((p) => p.connected) : []);

function randomNick() {
  const a = ['Zorro', 'Búho', 'Gato', 'Panda', 'Lobo', 'Delfín', 'Koala', 'Tigre', 'Halcón', 'Pulpo'];
  const b = ['Veloz', 'Curioso', 'Feliz', 'Sabio', 'Audaz', 'Tranqui', 'Brillante', 'Ninja', 'Cósmico', 'Genial'];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(a)} ${pick(b)}`;
}

function toast(text, ms = 2600) {
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(state.timers.toast);
  state.timers.toast = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function beep() {
  const ctx = state.audioCtx;
  if (!ctx) return;
  safe(() => {
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
    o.frequency.setValueAtTime(660, t);
    o.frequency.exponentialRampToValueAtTime(990, t + 0.15);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + 0.4);
  });
}

/* Carga servidores TURN desde config.js (si están configurados). */
async function loadIceServers() {
  const cfg = window.CHISPA_CONFIG || {};
  let turn = Array.isArray(cfg.turnServers) ? cfg.turnServers.filter((s) => s && s.urls) : [];
  if (cfg.meteredUrl) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(cfg.meteredUrl, { signal: ctrl.signal });
      clearTimeout(t);
      const list = await res.json();
      if (Array.isArray(list)) turn = turn.concat(list);
    } catch (e) {
      console.warn('No se pudieron cargar los servidores TURN', e);
    }
  }
  state.hasTurn = turn.some((s) => String(s.urls).includes('turn'));
  PEER_OPTS.config.iceServers = [...STUN_SERVERS, ...turn];
  console.info(`[Chispa] TURN ${state.hasTurn ? 'activo' : 'NO configurado'}`);
}

/* ================= Emparejador (solo corre en el anfitrión) ================= */
class Lobby {
  constructor() {
    this.clients = new Map();
    this.groups = new Map();
    this.timer = setInterval(() => this.tick(), 3000);
  }

  add(id, send, ref) {
    const c = this.clients.get(id) || {
      id, name: 'Anónimo', interests: [], size: MIN_SIZE, status: 'idle',
      gid: null, lastGroup: null, blocked: new Set(), waitingSince: 0,
    };
    c.send = send; c.ref = ref; c.seen = Date.now();
    this.clients.set(id, c);
  }

  remove(id, ref) {
    const c = this.clients.get(id);
    if (!c || (ref && c.ref !== ref)) return;
    this.clients.delete(id);
    this.leaveGroup(c);
    this.update();
  }

  info(c) { return { id: c.id, name: c.name, interests: c.interests }; }

  msg(id, m) {
    const c = this.clients.get(id);
    if (!c || !m || typeof m !== 'object') return;
    c.seen = Date.now();
    switch (m.type) {
      case 'hello':
        c.name = clean(m.name, 24) || 'Anónimo';
        c.interests = Array.isArray(m.interests) ? parseInterests(m.interests.join(',')) : [];
        c.size = clampSize(m.size);
        if (Array.isArray(m.blocked)) m.blocked.slice(0, 50).forEach((b) => typeof b === 'string' && c.blocked.add(b));
        if (m.status === 'busy' && typeof m.gid === 'string') this.restoreMember(c, m.gid, clampSize(m.groupSize));
        else if (m.status === 'waiting') { this.leaveGroup(c); this.setWaiting(c); }
        else { this.leaveGroup(c); c.status = 'idle'; }
        this.update();
        break;
      case 'find':
        this.leaveGroup(c);
        c.size = clampSize(m.size);
        this.setWaiting(c);
        this.update();
        break;
      case 'stop':
        this.leaveGroup(c);
        c.status = 'idle';
        this.update();
        break;
      case 'size':
        c.size = clampSize(m.size);
        this.update();
        break;
      case 'block':
        if (typeof m.who === 'string') c.blocked.add(m.who);
        break;
      case 'ping':
        safe(() => c.send({ type: 'stats', ...this.stats(c) }));
        // Los temporizadores se frenan en pestañas en segundo plano; los pings llegan por la red
        // y no se frenan, así que aprovechamos para reintentar el emparejamiento.
        if (c.status === 'waiting') this.placeAll();
        break;
    }
  }

  setWaiting(c) {
    c.status = 'waiting';
    c.waitingSince = Date.now();
  }

  // Tras un cambio de anfitrión, cada miembro avisa en qué grupo estaba y se reconstruye.
  restoreMember(c, gid, size) {
    let g = this.groups.get(gid);
    if (!g) { g = { id: gid, size, members: new Set(), changed: Date.now() }; this.groups.set(gid, g); }
    g.members.add(c.id);
    c.gid = gid; c.status = 'busy'; c.size = g.size;
  }

  leaveGroup(c) {
    if (!c.gid) return;
    const gid = c.gid;
    const g = this.groups.get(gid);
    c.gid = null; c.lastGroup = gid;
    if (!g) return;
    g.members.delete(c.id);
    g.changed = Date.now();
    for (const mid of g.members) {
      const m = this.clients.get(mid);
      if (m) safe(() => m.send({ type: 'left', gid, id: c.id }));
    }
    if (g.members.size <= 1) this.dissolve(g);
  }

  // Si en un grupo queda una sola persona, el grupo se disuelve y esa persona vuelve a buscar.
  dissolve(g) {
    this.groups.delete(g.id);
    for (const mid of g.members) {
      const m = this.clients.get(mid);
      if (!m) continue;
      m.gid = null; m.lastGroup = g.id;
      this.setWaiting(m);
      safe(() => m.send({ type: 'alone', gid: g.id }));
    }
  }

  blockedBetween(a, b) { return a.blocked.has(b.id) || b.blocked.has(a.id); }

  /*
   * Reglas de emparejamiento:
   *  - El número que eliges es tu MÁXIMO de personas por llamada.
   *  - Primero te juntamos con quienes eligieron exactamente tu mismo número.
   *  - Si tras FALLBACK_MS no hay nadie, aceptamos grupos más pequeños (7, 6, 5… hasta 1 a 1).
   *    El grupo nuevo toma el número más pequeño de sus integrantes, así nadie supera su máximo.
   */
  place(c) {
    if (c.status !== 'waiting') return;
    const now = Date.now();
    const patient = now - c.waitingSince > 8000;
    const flexible = (x) => now - x.waitingSince > FALLBACK_MS;
    let best = null, bestScore = -Infinity;

    // 1) Grupos abiertos (se prefieren para que se vayan llenando).
    for (const g of this.groups.values()) {
      if (g.members.size >= g.size) continue;
      const exact = g.size === c.size;
      if (!exact && !(g.size < c.size && flexible(c))) continue;
      if (g.id === c.lastGroup && !patient) continue;
      const members = [...g.members].map((id) => this.clients.get(id)).filter(Boolean);
      if (members.some((m) => this.blockedBetween(c, m))) continue;
      const common = new Set(members.flatMap((m) => commonInterests(c.interests, m.interests))).size;
      const score = (exact ? 300 : 100) + g.size * 3 + g.members.size * 5 + common * 10 + Math.random();
      if (score > bestScore) { best = { g }; bestScore = score; }
    }
    // 2) Otra persona esperando → grupo nuevo del tamaño más pequeño de los dos.
    for (const b of this.clients.values()) {
      if (b === c || b.status !== 'waiting' || this.blockedBetween(c, b)) continue;
      const size = Math.min(c.size, b.size);
      if ((c.size !== size && !flexible(c)) || (b.size !== size && !flexible(b))) continue;
      const recent = c.lastGroup && b.lastGroup === c.lastGroup;
      if (recent && (!patient || now - b.waitingSince < 8000)) continue;
      const score = (c.size === b.size ? 200 : 0) + size * 3
        + commonInterests(c.interests, b.interests).length * 10 + Math.random() - (recent ? 50 : 0);
      if (score > bestScore) { best = { b, size }; bestScore = score; }
    }
    if (!best) return;
    if (best.g) this.join(c, best.g);
    else this.create(c, best.b, best.size);
  }

  create(a, b, size) {
    const g = { id: `g${Math.random().toString(36).slice(2, 10)}`, size: clampSize(size), members: new Set([a.id, b.id]), changed: Date.now() };
    this.groups.set(g.id, g);
    a.status = b.status = 'busy';
    a.gid = b.gid = g.id;
    safe(() => a.send({ type: 'group', gid: g.id, size: g.size, members: [this.info(b)], connectTo: [b.id] }));
    safe(() => b.send({ type: 'group', gid: g.id, size: g.size, members: [this.info(a)], connectTo: [] }));
  }

  join(c, g) {
    const others = [...g.members].map((id) => this.clients.get(id)).filter(Boolean);
    g.members.add(c.id);
    g.changed = Date.now();
    c.status = 'busy'; c.gid = g.id;
    safe(() => c.send({ type: 'group', gid: g.id, size: g.size, members: others.map((m) => this.info(m)), connectTo: others.map((m) => m.id) }));
    for (const m of others) safe(() => m.send({ type: 'join', gid: g.id, member: this.info(c) }));
  }

  placeAll() { for (const c of [...this.clients.values()]) this.place(c); }

  update() { this.placeAll(); this.broadcastStats(); }

  stats() {
    let online = 0, waiting = 0, chatting = 0;
    const sizes = {};
    for (const c of this.clients.values()) {
      online++;
      if (c.status === 'waiting') waiting++;
      if (c.status === 'busy') chatting++;
      sizes[c.size] = (sizes[c.size] || 0) + 1;
    }
    return { online, waiting, chatting, sizes };
  }

  broadcastStats() {
    const s = { type: 'stats', ...this.stats() };
    for (const c of this.clients.values()) safe(() => c.send(s));
  }

  tick() {
    const now = Date.now();
    for (const c of [...this.clients.values()]) if (now - c.seen > 20000) this.remove(c.id);
    for (const g of [...this.groups.values()]) if (g.members.size <= 1 && now - g.changed > 15000) this.dissolve(g);
    this.update();
  }

  destroy() { clearInterval(this.timer); this.clients.clear(); this.groups.clear(); }
}

/* ================= Conexión a la sala ================= */
function setLobbyState(text, ok = false) {
  el.lblLobby.textContent = text;
  el.lobbyDot.classList.toggle('ok', ok);
}

function sameSizeCount() { return (state.stats.sizes && state.stats.sizes[state.size]) || 0; }

function renderStats() {
  const { online } = state.stats;
  const host = state.lobby ? ' · 👑' : '';
  setLobbyState(`${online} en la sala · ${sameSizeCount()} en ${sizeLabel(state.size)}${host}`, true);
  el.lblLobby.parentElement.title = state.lobby
    ? 'Tu navegador está haciendo de anfitrión de esta sala'
    : 'Conectado a la sala';
  if (state.searching && !state.group) updateSearchingHint();
}

function lobbySend(m) { if (state.lobbySend) state.lobbySend(m); }

function retryLobby() {
  clearTimeout(state.timers.lobbyRetry);
  state.timers.lobbyRetry = setTimeout(connectLobby, 800 + Math.random() * 2200);
}

function connectLobby() {
  clearTimeout(state.timers.lobbyRetry);
  if (state.lobbySend || state.pendingLobby || !state.me || state.me.destroyed) return;
  if (!state.lobbyFails) setLobbyState('Conectando a la sala…');
  const lp = new Peer(lobbyId(), PEER_OPTS);
  let settled = false;
  lp.on('open', () => { settled = true; becomeHost(lp); });
  lp.on('error', (err) => {
    if (!settled) {
      settled = true;
      lp.destroy();
      if (err.type === 'unavailable-id') joinLobbyAsClient();
      else retryLobby();
      return;
    }
    console.warn('lobby peer error', err.type);
    if (err.type === 'unavailable-id' || err.type === 'server-error') demoteHost(lp);
  });
}

function becomeHost(lp) {
  state.lobbyPeer = lp;
  state.lobby = new Lobby();
  state.lobbyFails = 0;
  lp.on('connection', (conn) => {
    conn.on('open', () => state.lobby && state.lobby.add(conn.peer, (d) => { if (conn.open) conn.send(d); }, conn));
    conn.on('data', (m) => state.lobby && state.lobby.msg(conn.peer, m));
    conn.on('close', () => state.lobby && state.lobby.remove(conn.peer, conn));
    conn.on('error', () => state.lobby && state.lobby.remove(conn.peer, conn));
  });
  lp.on('disconnected', () => setTimeout(() => { if (!lp.destroyed && lp.disconnected) lp.reconnect(); }, 1000));
  lp.on('close', () => demoteHost(lp));

  const myId = state.me.id;
  // Mensajes locales (el anfitrión también participa). queueMicrotask no se frena en segundo plano.
  state.lobby.add(myId, (d) => queueMicrotask(() => onLobbyMsg(d)), 'self');
  state.lobbySend = (m) => queueMicrotask(() => state.lobby && state.lobby.msg(myId, m));
  onLobbyReady();
}

function demoteHost(lp) {
  if (state.lobbyPeer !== lp) return;
  safe(() => state.lobby.destroy());
  state.lobby = null; state.lobbyPeer = null; state.lobbySend = null;
  safe(() => lp.destroy());
  retryLobby();
}

function joinLobbyAsClient() {
  const conn = state.me.connect(lobbyId(), { reliable: true });
  state.pendingLobby = conn;
  const fail = () => {
    if (state.pendingLobby !== conn) return;
    state.pendingLobby = null;
    safe(() => conn.close());
    state.lobbyFails++;
    if (state.lobbyFails >= 2) {
      setLobbyState('No logramos entrar a la sala, reintentando…');
      if (!state.warnedNetwork) { state.warnedNetwork = true; toast(NETWORK_TIP, 9000); }
    }
    retryLobby();
  };
  state.timers.lobbyJoin = setTimeout(fail, 8000);
  conn.on('open', () => {
    if (state.pendingLobby !== conn) return;
    clearTimeout(state.timers.lobbyJoin);
    state.pendingLobby = null;
    state.lobbyFails = 0;
    state.lobbyConn = conn;
    state.lastLobbyMsg = Date.now();
    state.lobbySend = (m) => { if (conn.open) conn.send(m); };
    onLobbyReady();
  });
  conn.on('data', (m) => { if (state.lobbyConn === conn) onLobbyMsg(m); });
  conn.on('close', () => {
    if (state.pendingLobby === conn) { fail(); return; }
    if (state.lobbyConn === conn) dropLobbyConn();
  });
  conn.on('error', fail);
  state.failPendingLobby = fail;
}

function dropLobbyConn() {
  const c = state.lobbyConn;
  state.lobbyConn = null; state.lobbySend = null;
  safe(() => c && c.close());
  setLobbyState('Reconectando a la sala…');
  retryLobby();
}

function onLobbyReady() {
  const g = state.group;
  lobbySend({
    type: 'hello', name: state.name, interests: state.interests, blocked: [...state.blocked], size: state.size,
    status: g ? 'busy' : state.searching ? 'waiting' : 'idle',
    gid: g ? g.gid : null, groupSize: g ? g.size : null,
  });
  lobbySend({ type: 'ping' });
  if (!state.timers.ping) {
    state.timers.ping = setInterval(() => {
      lobbySend({ type: 'ping' });
      if (state.lobbyConn && Date.now() - state.lastLobbyMsg > 16000) dropLobbyConn();
    }, 5000);
  }
}

function onLobbyMsg(m) {
  if (!m || typeof m !== 'object') return;
  state.lastLobbyMsg = Date.now();
  switch (m.type) {
    case 'stats':
      state.stats = {
        online: m.online | 0, waiting: m.waiting | 0, chatting: m.chatting | 0,
        sizes: m.sizes && typeof m.sizes === 'object' ? m.sizes : {},
      };
      renderStats();
      break;
    case 'group': onGroup(m); break;
    case 'join': onJoin(m); break;
    case 'left': onLeft(m); break;
    case 'alone': onAlone(m); break;
  }
}

/* ================= Peer propio ================= */
function initPeer() {
  setLobbyState('Conectando…');
  const me = new Peer(PEER_OPTS);
  state.me = me;
  me.on('open', () => { state.meOpened = true; connectLobby(); });
  me.on('disconnected', () => setTimeout(() => { if (!me.destroyed && me.disconnected) me.reconnect(); }, 1000));
  me.on('call', onIncomingCall);
  me.on('connection', onIncomingConn);
  me.on('error', (err) => {
    console.warn('peer error', err.type, err.message);
    const msg = String(err.message || '');
    if (err.type === 'peer-unavailable') {
      if (msg.includes(lobbyId()) && state.failPendingLobby) { state.failPendingLobby(); return; }
      for (const p of state.group ? [...state.group.peers.values()] : []) {
        if (msg.includes(p.id)) dropPeer(p.id, `No se pudo conectar con ${p.name} 😕`, true);
      }
      return;
    }
    if (err.type === 'browser-incompatible') { alert('Tu navegador no soporta videollamadas WebRTC. Prueba con Chrome, Edge, Firefox o Safari actualizados.'); return; }
    if (!state.meOpened) {
      setLobbyState('Sin conexión, reintentando…');
      safe(() => me.destroy());
      setTimeout(initPeer, 3000);
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      toast('Problema de red, reintentando…');
    }
  });
}

/* ================= Cámara y micrófono ================= */
async function initMedia(noCamera) {
  let cam = null, mic = null;
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    if (!noCamera) {
      try {
        const s = await md.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        cam = s.getVideoTracks()[0] || null;
        mic = s.getAudioTracks()[0] || null;
      } catch (e) {
        console.warn('getUserMedia', e);
        toast('No pudimos usar tu cámara: entras en modo avatar', 4000);
      }
    }
    if (!mic) {
      try { mic = (await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })).getAudioTracks()[0]; }
      catch { /* sin micrófono */ }
    }
  }
  state.hasCamera = !!cam;
  state.hasMic = !!mic;
  const tracks = [cam || makeAvatarTrack(), mic || makeSilentTrack()].filter(Boolean);
  state.localStream = new MediaStream(tracks);
  el.localVideo.srcObject = state.localStream;
  el.localVideo.classList.toggle('mirror', state.hasCamera);
  el.btnCam.disabled = !state.hasCamera;
  el.btnMic.disabled = !state.hasMic;
  if (!state.hasMic) el.btnMic.title = 'Sin micrófono';
  if (state.hasCamera) safe(async () => {
    const devices = await md.enumerateDevices();
    if (devices.filter((d) => d.kind === 'videoinput').length > 1) el.btnFlip.classList.remove('hidden');
  });
}

function makeAvatarTrack() {
  const c = document.createElement('canvas');
  c.width = 480; c.height = 360;
  const g = c.getContext('2d');
  const hue = [...state.name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
  const initial = (state.name[0] || '?').toUpperCase();
  const draw = () => {
    const t = Date.now() / 1000;
    const grad = g.createLinearGradient(0, 0, 480, 360);
    grad.addColorStop(0, `hsl(${hue}, 70%, 30%)`);
    grad.addColorStop(1, `hsl(${(hue + 60) % 360}, 70%, 18%)`);
    g.fillStyle = grad; g.fillRect(0, 0, 480, 360);
    const r = 78 + Math.sin(t * 2) * 4;
    g.beginPath(); g.arc(240, 160, r, 0, Math.PI * 2);
    g.fillStyle = `hsl(${hue}, 85%, 62%)`; g.fill();
    g.fillStyle = '#16121f'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 84px system-ui, sans-serif'; g.fillText(initial, 240, 166);
    g.fillStyle = '#fff'; g.font = '600 26px system-ui, sans-serif'; g.fillText(state.name, 240, 290);
    g.fillStyle = 'rgba(255,255,255,.6)'; g.font = '16px system-ui, sans-serif'; g.fillText('modo sin cámara', 240, 322);
  };
  draw();
  state.timers.avatar = setInterval(draw, 250);
  return c.captureStream ? c.captureStream(4).getVideoTracks()[0] : null;
}

function makeSilentTrack() {
  return safe(() => {
    const ctx = state.audioCtx;
    const dst = ctx.createMediaStreamDestination();
    const o = ctx.createOscillator(), g = ctx.createGain();
    g.gain.value = 0;
    o.connect(g).connect(dst); o.start();
    return dst.stream.getAudioTracks()[0];
  }) || null;
}

// En grupos grandes cada uno envía su video a todos: bajamos la calidad para que alcance la conexión.
function adjustQuality() {
  if (!state.hasCamera || !state.group) return;
  const track = state.localStream.getVideoTracks()[0];
  if (!track || !track.applyConstraints) return;
  const small = state.group.size >= 4;
  track.applyConstraints(small
    ? { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } }
    : { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }).catch(() => {});
}

function replaceSenderTrack(track) {
  for (const p of state.group ? state.group.peers.values() : []) {
    const pc = p.call && p.call.peerConnection;
    if (!pc) continue;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === track.kind);
    if (sender) sender.replaceTrack(track).catch(() => {});
  }
}

async function flipCamera() {
  const prev = state.facing;
  state.facing = prev === 'user' ? 'environment' : 'user';
  const old = state.localStream.getVideoTracks()[0];
  try {
    old.stop();
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: state.facing } });
    const nt = s.getVideoTracks()[0];
    nt.enabled = state.camOn;
    state.localStream.removeTrack(old);
    state.localStream.addTrack(nt);
    el.localVideo.srcObject = state.localStream;
    el.localVideo.classList.toggle('mirror', state.facing === 'user');
    replaceSenderTrack(nt);
    adjustQuality();
  } catch (e) {
    console.warn(e);
    state.facing = prev;
    toast('No se pudo cambiar de cámara');
  }
}

function toggleMic() {
  state.micOn = !state.micOn;
  state.localStream.getAudioTracks().forEach((t) => { t.enabled = state.micOn; });
  el.btnMic.classList.toggle('off', !state.micOn);
  el.btnMic.title = state.micOn ? 'Silenciar micrófono' : 'Activar micrófono';
  sendAll(mediaState());
}

function toggleCam() {
  state.camOn = !state.camOn;
  state.localStream.getVideoTracks().forEach((t) => { t.enabled = state.camOn; });
  el.btnCam.classList.toggle('off', !state.camOn);
  el.btnCam.title = state.camOn ? 'Apagar cámara' : 'Encender cámara';
  sendAll(mediaState());
}

const mediaState = () => ({ t: 'state', cam: state.hasCamera && state.camOn, mic: state.hasMic && state.micOn });

/* ================= Grupo: conexiones con cada persona ================= */
function onGroup(m) {
  if (typeof m.gid !== 'string' || !Array.isArray(m.members)) return;
  if (state.group) return;
  if (!state.searching) { lobbySend({ type: 'stop' }); return; }
  state.searching = false;
  state.group = { gid: m.gid, size: clampSize(m.size), peers: new Map(), startedAt: 0 };
  el.log.replaceChildren();
  if (state.group.size < state.size) {
    addMsg('sys', `No había suficientes personas para un ${sizeLabel(state.size)}, así que te unimos a ${state.group.size === 2 ? 'una conversación 1 a 1' : `un ${sizeLabel(state.group.size)}`}.`);
  }
  addMsg('sys', state.group.size === 2
    ? 'Conectando con alguien nuevo…'
    : `Entraste a un ${sizeLabel(state.group.size)}. Irán llegando más personas a medida que se conecten.`);
  const connectTo = new Set(Array.isArray(m.connectTo) ? m.connectTo : []);
  for (const mem of m.members) {
    const p = addPeer(mem);
    if (!p) continue;
    if (connectTo.has(p.id)) dialPeer(p);
    else attachEarly(p);
  }
  adjustQuality();
  setUI('group');
}

function onJoin(m) {
  if (!state.group || m.gid !== state.group.gid || !m.member) return;
  const p = addPeer(m.member);
  if (p) attachEarly(p);
  setUI('group');
}

function onLeft(m) {
  if (!state.group || m.gid !== state.group.gid) return;
  const p = getPeer(m.id);
  if (p) dropPeer(p.id, `${p.name} salió 👋`);
}

function onAlone(m) {
  if (!state.group || m.gid !== state.group.gid) return;
  groupEnded(state.group.size === 2 ? 'Tu compañero se fue 👋' : 'Todos los demás salieron del grupo 👋', true);
}

function addPeer(mem) {
  if (!state.group || !mem || typeof mem.id !== 'string' || mem.id === state.me.id) return null;
  if (state.group.peers.has(mem.id)) return null;
  const p = {
    id: mem.id,
    name: clean(mem.name, 24) || 'Anónimo',
    interests: Array.isArray(mem.interests) ? parseInterests(mem.interests.join(',')) : [],
    data: null, call: null, connected: false,
  };
  p.tile = createTile(p);
  state.group.peers.set(p.id, p);
  p.timer = setTimeout(() => {
    if (!p.connected) dropPeer(p.id, `No se pudo conectar con ${p.name} 😕`, true);
  }, 15000);
  renderTiles();
  return p;
}

function dialPeer(p) {
  setupData(p, state.me.connect(p.id, { reliable: true }));
  setupCall(p, state.me.call(p.id, state.localStream));
}

function attachEarly(p) {
  const conn = state.earlyConns.get(p.id);
  if (conn) { state.earlyConns.delete(p.id); setupData(p, conn); }
  const call = state.earlyCalls.get(p.id);
  if (call) { state.earlyCalls.delete(p.id); answerCall(p, call); }
}

function stashEarly(map, obj) {
  const prev = map.get(obj.peer);
  if (prev && prev !== obj) safe(() => prev.close());
  map.set(obj.peer, obj);
  setTimeout(() => {
    if (map.get(obj.peer) === obj) { map.delete(obj.peer); safe(() => obj.close()); }
  }, 10000);
}

function onIncomingConn(conn) {
  const p = getPeer(conn.peer);
  if (p && !p.data) setupData(p, conn);
  else stashEarly(state.earlyConns, conn);
}

function onIncomingCall(call) {
  const p = getPeer(call.peer);
  if (p && !p.call) answerCall(p, call);
  else stashEarly(state.earlyCalls, call);
}

function answerCall(p, call) {
  call.answer(state.localStream);
  setupCall(p, call);
}

function setupCall(p, call) {
  if (!call) return;
  p.call = call;
  call.on('stream', (stream) => {
    if (p.call !== call || getPeer(p.id) !== p) return;
    p.tile.video.srcObject = stream;
    p.tile.video.play().catch(() => {});
  });
  call.on('error', (e) => console.warn('call error', e));
}

function setupData(p, conn) {
  if (!conn) return;
  p.data = conn;
  const onOpen = () => {
    if (getPeer(p.id) !== p || p.data !== conn || p.connected) return;
    p.connected = true;
    clearTimeout(p.timer);
    safe(() => conn.send({ t: 'hello', name: state.name, interests: state.interests }));
    safe(() => conn.send(mediaState()));
    onPeerConnected(p);
  };
  if (conn.open) onOpen(); else conn.on('open', onOpen);
  conn.on('data', (d) => { if (p.data === conn && getPeer(p.id) === p) onPeerData(p, d); });
  conn.on('close', () => { if (p.data === conn && getPeer(p.id) === p) dropPeer(p.id, `${p.name} salió 👋`); });
  conn.on('error', (e) => console.warn('data error', e));
}

function onPeerConnected(p) {
  const g = state.group;
  if (!g.startedAt) {
    g.startedAt = Date.now();
    clearInterval(state.timers.clock);
    state.timers.clock = setInterval(updateClock, 1000);
    updateClock();
    if (matchMedia('(pointer: fine)').matches) el.inMsg.focus();
  }
  const common = commonInterests(state.interests, p.interests);
  addMsg('sys', `👋 ${p.name} ${g.size === 2 ? 'está contigo. ¡Saluda!' : 'se unió al grupo.'}${common.length ? ` En común: ${common.join(', ')} ✨` : ''}`);
  beep();
  updateTile(p);
  setUI('group');
}

function dropPeer(id, reason, failed) {
  const g = state.group;
  const p = g && g.peers.get(id);
  if (!p) return;
  g.peers.delete(id);
  clearTimeout(p.timer);
  safe(() => p.data && p.data.close());
  safe(() => p.call && p.call.close());
  p.tile.el.remove();
  renderTiles();
  if (reason) addMsg('sys', reason);
  if (failed && !state.hasTurn) addMsg('sys', NETWORK_TIP);
  if (g.peers.size === 0) groupEnded('', false);
  else setUI('group');
}

// Sale del grupo localmente (cierra todas las conexiones).
function leaveGroupLocal(sendBye) {
  const g = state.group;
  if (!g) return;
  state.group = null;
  clearInterval(state.timers.clock);
  clearTimeout(state.timers.typing);
  for (const p of g.peers.values()) {
    clearTimeout(p.timer);
    if (sendBye && p.data && p.data.open) safe(() => p.data.send({ t: 'bye' }));
    setTimeout(() => { safe(() => p.data && p.data.close()); safe(() => p.call && p.call.close()); }, sendBye ? 300 : 0);
  }
  el.tiles.replaceChildren();
  renderTiles();
  el.typing.classList.add('hidden');
}

// El grupo terminó (todos se fueron). Según "Auto", buscamos otro o nos detenemos.
function groupEnded(reason, lobbyAlreadyWaiting) {
  leaveGroupLocal(false);
  if (reason) addMsg('sys', reason);
  if (el.inAuto.checked) {
    state.searching = true;
    setUI('searching');
    clearTimeout(state.timers.auto);
    if (!lobbyAlreadyWaiting) {
      state.timers.auto = setTimeout(() => {
        if (state.searching && !state.group) lobbySend({ type: 'find', size: state.size });
      }, 1200);
    }
  } else {
    state.searching = false;
    setUI('idle');
    lobbySend({ type: 'stop' });
  }
}

function find() {
  if (!state.me) return;
  clearTimeout(state.timers.auto);
  leaveGroupLocal(true);
  state.searching = true;
  setUI('searching');
  lobbySend({ type: 'find', size: state.size });
}

function stop() {
  clearTimeout(state.timers.auto);
  leaveGroupLocal(true);
  state.searching = false;
  setUI('idle');
  lobbySend({ type: 'stop' });
}

function blockPeer(id) {
  const p = getPeer(id);
  if (!p) return;
  if (!confirm(`¿Bloquear a ${p.name}? No volverá a tocarte en esta sesión y saldrás de esta conversación.`)) return;
  state.blocked.add(p.id);
  lobbySend({ type: 'block', who: p.id });
  const name = p.name;
  find();
  addMsg('sys', `Bloqueaste a ${name}.`);
}

function sendAll(obj) {
  let n = 0;
  for (const p of connectedPeers()) {
    if (p.data && p.data.open) { safe(() => p.data.send(obj)); n++; }
  }
  return n > 0;
}

function onPeerData(p, d) {
  if (!d || typeof d !== 'object') return;
  switch (d.t) {
    case 'hello': {
      const n = clean(d.name, 24);
      if (n) { p.name = n; updateTile(p); }
      break;
    }
    case 'msg': {
      // Aunque alguien modifique la app, aquí también aplicamos el límite y una espera mínima.
      const now = Date.now();
      if (now - (p.lastMsgAt || 0) < 1000) break;
      p.lastMsgAt = now;
      const text = clean(d.text, MAX_MSG);
      if (text) { addMsg('them', text, p.name); el.typing.classList.add('hidden'); }
      break;
    }
    case 'typing':
      el.typing.textContent = `${p.name} está escribiendo…`;
      el.typing.classList.remove('hidden');
      clearTimeout(state.timers.typing);
      state.timers.typing = setTimeout(() => el.typing.classList.add('hidden'), 2500);
      break;
    case 'react':
      if (EMOJIS.includes(d.e)) floatEmoji(p.tile.reactions, d.e);
      break;
    case 'game': {
      const game = Object.prototype.hasOwnProperty.call(GAMES, d.g) ? GAMES[d.g] : null;
      const now = Date.now();
      if (now - (p.lastGameAt || 0) < GAME_COOLDOWN - 1500) break;
      if (game && Number.isInteger(d.i) && game.list[d.i]) {
        p.lastGameAt = now;
        addGameMsg(game, p.name, game.list[d.i]);
      }
      break;
    }
    case 'state': {
      const flags = [];
      if (!d.mic) flags.push('🔇');
      if (!d.cam) flags.push('🚫📷');
      p.tile.flags.textContent = flags.join(' ');
      break;
    }
    case 'bye':
      dropPeer(p.id, `${p.name} salió 👋`);
      break;
  }
}

/* ================= Interfaz ================= */
function createTile(p) {
  const wrap = document.createElement('div');
  wrap.className = 'tile connecting';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  const wait = document.createElement('div');
  wait.className = 'tile-wait';
  const sp = document.createElement('div');
  sp.className = 'spinner small';
  const wt = document.createElement('span');
  wt.textContent = 'Conectando…';
  wait.append(sp, wt);
  const label = document.createElement('div');
  label.className = 'tile-label';
  const nameEl = document.createElement('b');
  nameEl.textContent = p.name;
  const flags = document.createElement('span');
  label.append(nameEl, flags);
  const block = document.createElement('button');
  block.type = 'button';
  block.className = 'tile-block';
  block.title = `Bloquear a ${p.name}`;
  block.textContent = '🚫';
  block.addEventListener('click', () => blockPeer(p.id));
  const reactions = document.createElement('div');
  reactions.className = 'reactions';
  wrap.append(video, wait, label, block, reactions);
  el.tiles.append(wrap);
  return { el: wrap, video, nameEl, flags, reactions };
}

function updateTile(p) {
  p.tile.el.classList.toggle('connecting', !p.connected);
  p.tile.nameEl.textContent = p.name;
}

function renderTiles() {
  const n = el.tiles.children.length;
  el.tiles.className = `tiles n${Math.min(n, 7)}`;
  el.videos.classList.toggle('many', n >= 3);
  const g = state.group;
  if (g) {
    const here = connectedPeers().length + 1;
    el.groupLabel.textContent = g.size === 2 ? '1 a 1' : `👥 ${here}/${g.size}`;
    el.groupTag.title = g.size === 2 ? '' : `${here} de ${g.size} personas conectadas`;
  }
}

function updateClock() {
  const g = state.group;
  if (!g || !g.startedAt) return;
  const s = Math.floor((Date.now() - g.startedAt) / 1000);
  el.timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function updateSearchingHint() {
  const same = Math.max(0, sameSizeCount() - 1);
  const anyone = Math.max(0, state.stats.online - 1);
  const mode = sizeLabel(state.size);
  if (same > 0) {
    el.overlaySub.textContent = `Hay ${same} persona${same === 1 ? '' : 's'} más con tu mismo ajuste (${mode}).`
      + (state.size > 2 ? ' Si no se juntan suficientes, te uniremos a un grupo más pequeño.' : '');
  } else if (anyone > 0 && state.size > 2) {
    el.overlaySub.textContent = `Nadie más eligió ${mode}. En unos segundos te uniremos con quienes eligieron un grupo más pequeño.`;
  } else if (anyone > 0) {
    el.overlaySub.textContent = `Hay ${anyone} persona${anyone === 1 ? '' : 's'} más en la sala. Te conectamos en cuanto alguien pulse Empezar.`;
  } else {
    el.overlaySub.textContent = 'Por ahora estás solo en la sala. ¡Invita a alguien con el botón 🔗 Invitar!';
  }
}

function setUI(mode) {
  const inGroup = mode === 'group';
  const live = inGroup && connectedPeers().length > 0;
  el.overlay.classList.toggle('hidden', inGroup);
  el.spinner.classList.toggle('hidden', mode === 'idle');
  el.groupTag.classList.toggle('hidden', !inGroup);
  el.btnStop.disabled = mode === 'idle';
  state.chatLive = live;
  el.inMsg.disabled = !live;
  refreshCooldowns();
  el.btnNext.textContent = mode === 'idle' ? '▶ Empezar' : '⏭ Siguiente';
  el.overlaySub.textContent = '';
  if (mode === 'idle') {
    el.overlayText.innerHTML = 'Pulsa <b>Empezar</b> para conocer a alguien';
  } else if (mode === 'searching') {
    const who = state.size === 2 ? 'a alguien' : `un ${sizeLabel(state.size)}`;
    el.overlayText.textContent = isPublicRoom()
      ? `Buscando ${who} al azar en la sala pública…`
      : `Buscando ${who} en #${state.sala}…`;
    updateSearchingHint();
  } else if (inGroup) {
    renderTiles();
    if (!state.group.startedAt) el.timer.textContent = '00:00';
  }
}

function addMsg(kind, text, who) {
  const d = document.createElement('div');
  d.className = `msg ${kind}`;
  if (kind === 'me' || kind === 'them') {
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = kind === 'me' ? 'Tú' : (who || 'Alguien');
    d.append(w);
  }
  const t = document.createElement('span');
  t.textContent = text;
  d.append(t);
  el.log.append(d);
  el.log.scrollTop = el.log.scrollHeight;
}

function addGameMsg(game, who, text) {
  const d = document.createElement('div');
  d.className = 'msg ice';
  const head = document.createElement('span');
  head.className = 'who';
  head.textContent = `${game.icon} ${game.title} · ${who}`;
  const t = document.createElement('span');
  t.textContent = text;
  d.append(head, t);
  el.log.append(d);
  el.log.scrollTop = el.log.scrollHeight;
}

function floatEmoji(container, emoji) {
  const s = document.createElement('span');
  s.className = 'float-emoji';
  s.textContent = emoji;
  s.style.left = `${10 + Math.random() * 75}%`;
  container.append(s);
  setTimeout(() => s.remove(), 2300);
}

function shareUrl() {
  const u = new URL(location.href);
  u.search = ''; u.hash = '';
  const sala = state.sala || slug(el.inSala.value);
  if (sala !== PUBLIC_ROOM) u.searchParams.set('sala', sala);
  return u.toString();
}

function openShare() {
  const url = shareUrl();
  el.shareLink.value = url;
  el.shareSala.textContent = isPublicRoom() ? 'pública' : `#${state.sala}`;
  el.qr.replaceChildren();
  if (window.qrcode) safe(() => {
    const q = window.qrcode(0, 'M');
    q.addData(url); q.make();
    el.qr.innerHTML = q.createSvgTag(5, 2);
  });
  el.qr.classList.toggle('hidden', !el.qr.firstChild);
  el.btnNativeShare.classList.toggle('hidden', !navigator.share);
  el.dlgShare.showModal();
}

async function copyLink() {
  const url = el.shareLink.value;
  try { await navigator.clipboard.writeText(url); }
  catch { el.shareLink.select(); safe(() => document.execCommand('copy')); }
  toast('Enlace copiado ✅');
}

/* ----- Selector de tamaño de grupo ----- */
function setSize(n, fromUser) {
  state.size = clampSize(n);
  storeSet('chispa:size', String(state.size));
  el.sizePicker.querySelectorAll('button').forEach((b) => {
    const on = Number(b.dataset.size) === state.size;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  el.selSize.value = String(state.size);
  el.sizeHint.textContent = state.size === 2
    ? 'Conversación 1 a 1: tú y otra persona.'
    : `Llamada grupal de hasta ${state.size} personas contándote a ti. Primero buscamos a quienes eligieron ${state.size}; si no hay, te unimos a un grupo más pequeño.`;
  if (!fromUser || !state.me) return;
  lobbySend({ type: 'size', size: state.size });
  if (state.searching && !state.group) {
    lobbySend({ type: 'find', size: state.size });
    setUI('searching');
  } else if (state.group) {
    toast(`Se aplicará cuando pases a Siguiente (${sizeLabel(state.size)})`);
  }
  renderStats();
}

/* ================= Eventos ================= */
el.sizePicker.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-size]');
  if (b) setSize(b.dataset.size, true);
});
el.selSize.addEventListener('change', () => setSize(el.selSize.value, true));

el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  state.name = clean(el.inName.value, 24) || randomNick();
  state.sala = slug(el.inSala.value);
  state.interests = parseInterests(el.inIntereses.value);
  storeSet('chispa:name', clean(el.inName.value, 24));
  storeSet('chispa:interests', el.inIntereses.value);
  safe(() => { state.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); });

  const url = new URL(location.href);
  if (isPublicRoom()) url.searchParams.delete('sala');
  else url.searchParams.set('sala', state.sala);
  history.replaceState(null, '', url);

  el.inicio.classList.add('hidden');
  el.app.classList.remove('hidden');
  el.lblSala.textContent = roomLabel();
  setUI('idle');
  await Promise.all([initMedia(el.inSoloTexto.checked), loadIceServers()]);
  initPeer();
});

el.verNormas.addEventListener('click', (e) => { e.preventDefault(); el.dlgNormas.showModal(); });
document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

el.btnNext.addEventListener('click', find);
el.btnStop.addEventListener('click', stop);
el.btnMic.addEventListener('click', toggleMic);
el.btnCam.addEventListener('click', toggleCam);
el.btnFlip.addEventListener('click', flipCamera);
el.btnShare.addEventListener('click', openShare);
el.btnCopy.addEventListener('click', copyLink);
el.btnNativeShare.addEventListener('click', () => {
  const text = isPublicRoom() ? '¡Entra a Chispa y conoce a alguien al azar!' : `¡Entra a mi sala #${state.sala} en Chispa!`;
  navigator.share({ title: 'Chispa', text, url: el.shareLink.value }).catch(() => {});
});

/* ----- Esperas (cooldowns) del chat y de los juegos ----- */
const secondsLeft = (since, ms) => Math.max(0, Math.ceil((since + ms - Date.now()) / 1000));

function refreshCooldowns() {
  clearTimeout(state.timers.cooldown);
  const live = !!state.chatLive;
  const msgLeft = secondsLeft(state.lastMsgAt || 0, MSG_COOLDOWN);
  const gameLeft = secondsLeft(state.lastGameAt || 0, GAME_COOLDOWN);
  el.btnSend.disabled = !live || msgLeft > 0;
  el.btnSend.textContent = msgLeft > 0 ? `${msgLeft}s` : 'Enviar';
  el.quick.querySelectorAll('.emojis button').forEach((b) => { b.disabled = !live; });
  el.quick.querySelectorAll('button[data-game]').forEach((b) => {
    b.disabled = !live || gameLeft > 0;
    b.textContent = gameLeft > 0 ? `${b.dataset.label} · ${gameLeft}s` : b.dataset.label;
  });
  if (msgLeft > 0 || gameLeft > 0) state.timers.cooldown = setTimeout(refreshCooldowns, 250);
}

function updateCounter() {
  const n = el.inMsg.value.length;
  el.msgCounter.textContent = `${n}/${MAX_MSG}`;
  el.msgCounter.classList.toggle('warn', n >= MAX_MSG - 20);
}

el.formChat.addEventListener('submit', (e) => {
  e.preventDefault();
  const wait = secondsLeft(state.lastMsgAt || 0, MSG_COOLDOWN);
  if (wait > 0) { toast(`Espera ${wait}s para enviar otro mensaje`); return; }
  const text = clean(el.inMsg.value, MAX_MSG);
  if (!text) return;
  if (sendAll({ t: 'msg', text })) {
    addMsg('me', text);
    el.inMsg.value = '';
    updateCounter();
    state.lastMsgAt = Date.now();
    refreshCooldowns();
  }
});
el.inMsg.addEventListener('input', () => {
  updateCounter();
  if (Date.now() - state.lastTypingSent > 1500) { state.lastTypingSent = Date.now(); sendAll({ t: 'typing' }); }
});

el.quick.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const game = b.dataset.game && GAMES[b.dataset.game];
  if (game) {
    const wait = secondsLeft(state.lastGameAt || 0, GAME_COOLDOWN);
    if (wait > 0 || !game.list.length) return;
    const i = drawCard(game);
    if (sendAll({ t: 'game', g: b.dataset.game, i })) {
      addGameMsg(game, 'Tú', game.list[i]);
      state.lastGameAt = Date.now();
      refreshCooldowns();
    }
  } else if (b.dataset.emoji && sendAll({ t: 'react', e: b.dataset.emoji })) {
    floatEmoji(el.reactLocal, b.dataset.emoji);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || el.app.classList.contains('hidden')) return;
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  find();
});

window.addEventListener('pagehide', () => {
  sendAll({ t: 'bye' });
  safe(() => state.lobbyPeer && state.lobbyPeer.destroy());
  safe(() => state.me && state.me.destroy());
});

/* ================= Arranque ================= */
// Chispas flotando en la pantalla de inicio.
function makeEmbers() {
  const box = document.getElementById('embers');
  if (!box || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const count = innerWidth < 600 ? 22 : 40;
  for (let i = 0; i < count; i++) {
    const s = document.createElement('span');
    const size = 2 + Math.random() * 5;
    s.style.left = `${Math.random() * 100}%`;
    s.style.width = s.style.height = `${size}px`;
    s.style.animationDuration = `${6 + Math.random() * 8}s`;
    s.style.animationDelay = `${-Math.random() * 14}s`;
    s.style.setProperty('--drift', `${Math.round((Math.random() - 0.5) * 140)}px`);
    box.append(s);
  }
}

(function boot() {
  makeEmbers();
  const params = new URLSearchParams(location.search);
  const salaParam = params.get('sala');
  if (salaParam && slug(salaParam) !== PUBLIC_ROOM) el.inSala.value = salaParam;
  el.inName.value = storeGet('chispa:name') || '';
  el.inIntereses.value = storeGet('chispa:interests') || '';
  setSize(params.get('grupo') || storeGet('chispa:size') || 2, false);
  el.quick.querySelectorAll('button[data-game]').forEach((b) => { b.dataset.label = b.textContent.trim(); });
  el.inMsg.maxLength = MAX_MSG;
  updateCounter();
  if (!window.Peer) {
    toast('No se pudo cargar PeerJS. Revisa tu conexión a internet.', 6000);
  }
})();
