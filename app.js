'use strict';
/*
 * Chispa — videochat aleatorio por salas.
 *
 * Cómo funciona (sin servidor propio):
 *  - Cada navegador crea un "peer" con PeerJS (usa el servidor público gratuito de PeerJS
 *    solo para presentarse; el video y el chat viajan directo entre navegadores por WebRTC).
 *  - Por cada sala existe un "anfitrión": el primer navegador que logra reservar el ID
 *    `chispa-v1-<sala>`. Ese navegador hace de emparejador (lobby): lleva la lista de
 *    quién está buscando y los empareja (priorizando intereses en común).
 *  - Si el anfitrión se va, los demás compiten por reservar el ID y uno nuevo toma el relevo.
 */

const PREFIX = 'chispa-v1-';
const PEER_OPTS = {
  debug: 1,
  config: { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] },
};
const EMOJIS = ['👋', '😂', '❤️', '🔥', '👏'];
const ROMPEHIELOS = [
  '¿Cuál es la última canción que tuviste en repetición?',
  '¿Qué app usas más en tu teléfono y por qué?',
  'Si pudieras aprender una habilidad en un día, ¿cuál sería?',
  '¿Cuál es tu comida favorita para un día malo?',
  '¿Qué serie o película recomendarías sin dudar?',
  '¿Qué es lo más raro que sabes hacer?',
  'Si tuvieras que crear una app mañana, ¿de qué sería?',
  '¿Playa, montaña o ciudad?',
  '¿Cuál fue el mejor momento de tu semana?',
  '¿Qué lugar del mundo te gustaría conocer?',
  '¿Madrugar o trasnochar?',
  '¿Qué videojuego, libro o cómic te marcó?',
  'Cuéntame un dato curioso que casi nadie sepa.',
  '¿Qué superpoder elegirías y para qué lo usarías?',
  '¿Cuál es tu plan ideal de fin de semana?',
];

const $ = (s) => document.querySelector(s);
const el = {
  inicio: $('#inicio'), app: $('#app'), form: $('#formInicio'),
  inName: $('#inName'), inSala: $('#inSala'), inIntereses: $('#inIntereses'),
  inSoloTexto: $('#inSoloTexto'), verNormas: $('#verNormas'),
  lblSala: $('#lblSala'), lblLobby: $('#lblLobby'), lobbyDot: $('#lobbyDot'),
  remoteVideo: $('#remoteVideo'), localVideo: $('#localVideo'),
  overlay: $('#overlay'), overlayText: $('#overlayText'), overlaySub: $('#overlaySub'), spinner: $('#spinner'),
  partnerTag: $('#partnerTag'), partnerName: $('#partnerName'), partnerFlags: $('#partnerFlags'), timer: $('#timer'),
  btnNext: $('#btnNext'), btnStop: $('#btnStop'), btnMic: $('#btnMic'), btnCam: $('#btnCam'),
  btnFlip: $('#btnFlip'), btnBlock: $('#btnBlock'), btnShare: $('#btnShare'), btnIce: $('#btnIce'),
  inAuto: $('#inAuto'), quick: $('#quick'),
  log: $('#log'), typing: $('#typing'), formChat: $('#formChat'), inMsg: $('#inMsg'), btnSend: $('#btnSend'),
  reactRemote: $('#reactRemote'), reactLocal: $('#reactLocal'),
  dlgShare: $('#dlgShare'), dlgNormas: $('#dlgNormas'), shareLink: $('#shareLink'), shareSala: $('#shareSala'),
  qr: $('#qr'), btnCopy: $('#btnCopy'), btnNativeShare: $('#btnNativeShare'), toast: $('#toast'),
};

const state = {
  name: '', sala: '', interests: [],
  me: null, meOpened: false,
  lobbyPeer: null, lobby: null, lobbyConn: null, pendingLobby: null, lobbySend: null, lastLobbyMsg: 0,
  stats: { online: 0, waiting: 0, chatting: 0 },
  audioCtx: null, localStream: null, hasCamera: false, hasMic: false, camOn: true, micOn: true, facing: 'user',
  partner: null, data: null, call: null, searching: false, connectedAt: 0, lastTypingSent: 0,
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
const safe = (fn) => { try { return fn(); } catch (e) { console.warn(e); } };
const storeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const storeSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };
const lobbyId = () => PREFIX + state.sala;
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

/* ================= Emparejador (solo corre en el anfitrión) ================= */
class Lobby {
  constructor() {
    this.clients = new Map();
    this.timer = setInterval(() => this.tick(), 3000);
  }
  add(id, send, ref) {
    this.clients.set(id, {
      id, send, ref, name: 'Anónimo', interests: [], status: 'idle',
      blocked: new Set(), last: null, waitingSince: 0, seen: Date.now(),
    });
  }
  remove(id, ref) {
    const c = this.clients.get(id);
    if (!c || (ref && c.ref !== ref)) return;
    this.clients.delete(id);
    this.broadcastStats();
  }
  msg(id, m) {
    const c = this.clients.get(id);
    if (!c || !m || typeof m !== 'object') return;
    c.seen = Date.now();
    switch (m.type) {
      case 'hello':
        c.name = clean(m.name, 24) || 'Anónimo';
        c.interests = Array.isArray(m.interests) ? parseInterests(m.interests.join(',')) : [];
        if (Array.isArray(m.blocked)) m.blocked.slice(0, 50).forEach((b) => typeof b === 'string' && c.blocked.add(b));
        c.status = m.status === 'busy' ? 'busy' : 'idle';
        if (m.status === 'waiting') this.setWaiting(c);
        this.broadcastStats();
        break;
      case 'find': this.setWaiting(c); this.broadcastStats(); break;
      case 'stop': c.status = 'idle'; this.broadcastStats(); break;
      case 'block': if (typeof m.who === 'string') c.blocked.add(m.who); break;
      case 'ping':
        safe(() => c.send({ type: 'stats', ...this.stats() }));
        // Los temporizadores se frenan en pestañas en segundo plano; los pings llegan por la red
        // y no se frenan, así que aprovechamos para reintentar el emparejamiento.
        if (c.status === 'waiting') this.tryMatch(c);
        break;
    }
  }
  setWaiting(c) {
    c.status = 'waiting';
    c.waitingSince = Date.now();
    this.tryMatch(c);
  }
  stats() {
    let online = 0, waiting = 0, chatting = 0;
    for (const c of this.clients.values()) {
      online++;
      if (c.status === 'waiting') waiting++;
      if (c.status === 'busy') chatting++;
    }
    return { online, waiting, chatting };
  }
  broadcastStats() {
    const s = { type: 'stats', ...this.stats() };
    for (const c of this.clients.values()) safe(() => c.send(s));
  }
  tryMatch(a) {
    if (a.status !== 'waiting') return;
    const now = Date.now();
    let best = null, bestScore = -Infinity;
    for (const b of this.clients.values()) {
      if (b === a || b.status !== 'waiting') continue;
      if (a.blocked.has(b.id) || b.blocked.has(a.id)) continue;
      // Evita repetir con la última persona, salvo que ambos lleven rato esperando.
      const repeat = a.last === b.id || b.last === a.id;
      if (repeat && (now - a.waitingSince < 8000 || now - b.waitingSince < 8000)) continue;
      const score = commonInterests(a.interests, b.interests).length * 10 + Math.random() - (repeat ? 100 : 0);
      if (score > bestScore) { best = b; bestScore = score; }
    }
    if (!best) return;
    const common = commonInterests(a.interests, best.interests);
    a.status = best.status = 'busy';
    a.last = best.id; best.last = a.id;
    safe(() => a.send({ type: 'match', partner: best.id, name: best.name, common, initiator: true }));
    safe(() => best.send({ type: 'match', partner: a.id, name: a.name, common, initiator: false }));
    this.broadcastStats();
  }
  tick() {
    const now = Date.now();
    for (const c of [...this.clients.values()]) if (now - c.seen > 20000) this.remove(c.id);
    for (const c of this.clients.values()) this.tryMatch(c);
  }
  destroy() { clearInterval(this.timer); this.clients.clear(); }
}

/* ================= Conexión a la sala ================= */
function setLobbyState(text, ok = false) {
  el.lblLobby.textContent = text;
  el.lobbyDot.classList.toggle('ok', ok);
}

function renderStats() {
  const { online, waiting } = state.stats;
  const host = state.lobby ? ' · 👑' : '';
  setLobbyState(`${online} en la sala · ${waiting} buscando${host}`, true);
  el.lblLobby.parentElement.title = state.lobby
    ? 'Tu navegador está haciendo de anfitrión de esta sala'
    : 'Conectado a la sala';
  if (state.searching && !state.partner) updateSearchingHint();
}

function lobbySend(m) { if (state.lobbySend) state.lobbySend(m); }

function retryLobby() {
  clearTimeout(state.timers.lobbyRetry);
  state.timers.lobbyRetry = setTimeout(connectLobby, 800 + Math.random() * 2200);
}

function connectLobby() {
  clearTimeout(state.timers.lobbyRetry);
  if (state.lobbySend || state.pendingLobby || !state.me || state.me.destroyed) return;
  setLobbyState('Conectando a la sala…');
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
  lp.on('connection', (conn) => {
    conn.on('open', () => state.lobby && state.lobby.add(conn.peer, (d) => { if (conn.open) conn.send(d); }, conn));
    conn.on('data', (m) => state.lobby && state.lobby.msg(conn.peer, m));
    conn.on('close', () => state.lobby && state.lobby.remove(conn.peer, conn));
    conn.on('error', () => state.lobby && state.lobby.remove(conn.peer, conn));
  });
  lp.on('disconnected', () => setTimeout(() => { if (!lp.destroyed && lp.disconnected) lp.reconnect(); }, 1000));
  lp.on('close', () => demoteHost(lp));

  const myId = state.me.id;
  // Mensajes locales (el anfitrión también es participante). queueMicrotask no se frena en segundo plano.
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
    retryLobby();
  };
  state.timers.lobbyJoin = setTimeout(fail, 8000);
  conn.on('open', () => {
    if (state.pendingLobby !== conn) return;
    clearTimeout(state.timers.lobbyJoin);
    state.pendingLobby = null;
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
  lobbySend({
    type: 'hello', name: state.name, interests: state.interests, blocked: [...state.blocked],
    status: state.partner ? 'busy' : state.searching ? 'waiting' : 'idle',
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
  if (m.type === 'stats') {
    state.stats = { online: m.online | 0, waiting: m.waiting | 0, chatting: m.chatting | 0 };
    renderStats();
  } else if (m.type === 'match') {
    if (!state.searching || state.partner || typeof m.partner !== 'string') return;
    if (state.blocked.has(m.partner)) { lobbySend({ type: 'find' }); return; }
    startWithPartner(m);
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
      if (msg.includes(lobbyId()) && state.failPendingLobby) state.failPendingLobby();
      else if (state.partner && msg.includes(state.partner.id)) partnerLeft('No se pudo conectar con esa persona 😕');
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

function replaceSenderTrack(track) {
  const pc = state.call && state.call.peerConnection;
  if (!pc) return;
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === track.kind);
  if (sender) sender.replaceTrack(track).catch(() => {});
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
  el.btnMic.textContent = state.micOn ? '🎤' : '🔇';
  el.btnMic.title = state.micOn ? 'Silenciar micrófono' : 'Activar micrófono';
  sendMediaState();
}

function toggleCam() {
  state.camOn = !state.camOn;
  state.localStream.getVideoTracks().forEach((t) => { t.enabled = state.camOn; });
  el.btnCam.classList.toggle('off', !state.camOn);
  el.btnCam.title = state.camOn ? 'Apagar cámara' : 'Encender cámara';
  sendMediaState();
}

function sendMediaState() {
  sendPeer({ t: 'state', cam: state.hasCamera && state.camOn, mic: state.hasMic && state.micOn });
}

/* ================= Emparejamiento con otra persona ================= */
function startWithPartner(m) {
  state.searching = false;
  clearTimeout(state.timers.alone);
  state.partner = {
    id: m.partner, name: clean(m.name, 24) || 'Anónimo',
    common: Array.isArray(m.common) ? m.common.map((x) => clean(x, 20)).slice(0, 8) : [],
  };
  setUI('connecting');
  state.timers.connect = setTimeout(() => {
    if (!state.data || !state.data.open) partnerLeft('No se pudo conectar 😕 Buscando a otra persona…');
  }, 12000);

  if (m.initiator) {
    setupData(state.me.connect(m.partner, { reliable: true }));
    setupCall(state.me.call(m.partner, state.localStream));
  } else {
    const conn = state.earlyConns.get(m.partner);
    if (conn) { state.earlyConns.delete(m.partner); setupData(conn); }
    const call = state.earlyCalls.get(m.partner);
    if (call) { state.earlyCalls.delete(m.partner); answerCall(call); }
  }
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
  if (state.partner && conn.peer === state.partner.id && !state.data) setupData(conn);
  else stashEarly(state.earlyConns, conn);
}

function onIncomingCall(call) {
  if (state.partner && call.peer === state.partner.id && !state.call) answerCall(call);
  else stashEarly(state.earlyCalls, call);
}

function answerCall(call) {
  call.answer(state.localStream);
  setupCall(call);
}

function setupCall(call) {
  if (!call) return;
  state.call = call;
  call.on('stream', (stream) => {
    if (state.call !== call) return;
    el.remoteVideo.srcObject = stream;
    el.remoteVideo.play().catch(() => {});
  });
  call.on('error', (e) => console.warn('call error', e));
}

function setupData(conn) {
  if (!conn) return;
  state.data = conn;
  const onOpen = () => {
    if (state.data !== conn) return;
    clearTimeout(state.timers.connect);
    conn.send({ t: 'hello', name: state.name, interests: state.interests });
    sendMediaState();
    onConnected();
  };
  if (conn.open) onOpen(); else conn.on('open', onOpen);
  conn.on('data', (d) => { if (state.data === conn) onPeerData(d); });
  conn.on('close', () => { if (state.data === conn) partnerLeft('Tu compañero se fue 👋'); });
  conn.on('error', (e) => console.warn('data error', e));
}

function onConnected() {
  state.connectedAt = Date.now();
  el.log.replaceChildren();
  const p = state.partner;
  addMsg('sys', `Estás hablando con ${p.name}. ¡Saluda! 👋`);
  if (p.common.length) addMsg('sys', `Tienen en común: ${p.common.join(', ')} ✨`);
  setUI('connected');
  beep();
  clearInterval(state.timers.clock);
  state.timers.clock = setInterval(updateClock, 1000);
  updateClock();
  if (matchMedia('(pointer: fine)').matches) el.inMsg.focus();
}

function updateClock() {
  if (!state.connectedAt) return;
  const s = Math.floor((Date.now() - state.connectedAt) / 1000);
  el.timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function onPeerData(d) {
  if (!d || typeof d !== 'object') return;
  switch (d.t) {
    case 'hello':
      if (state.partner) {
        const n = clean(d.name, 24);
        if (n) { state.partner.name = n; el.partnerName.textContent = n; }
      }
      break;
    case 'msg': {
      const text = clean(d.text, 500);
      if (text) { addMsg('them', text); el.typing.classList.add('hidden'); }
      break;
    }
    case 'typing':
      el.typing.classList.remove('hidden');
      clearTimeout(state.timers.typing);
      state.timers.typing = setTimeout(() => el.typing.classList.add('hidden'), 2500);
      break;
    case 'react':
      if (EMOJIS.includes(d.e)) floatEmoji(el.reactRemote, d.e);
      break;
    case 'ice':
      if (Number.isInteger(d.i) && ROMPEHIELOS[d.i]) addMsg('ice', `🎲 ${ROMPEHIELOS[d.i]}`);
      break;
    case 'state': {
      const flags = [];
      if (!d.mic) flags.push('🔇');
      if (!d.cam) flags.push('🚫📷');
      el.partnerFlags.textContent = flags.join(' ');
      break;
    }
    case 'bye':
      partnerLeft('Tu compañero pasó a la siguiente persona 👋');
      break;
  }
}

function sendPeer(obj) {
  if (state.data && state.data.open) { safe(() => state.data.send(obj)); return true; }
  return false;
}

function cleanupPartner(sendBye) {
  ['connect', 'auto', 'typing'].forEach((k) => clearTimeout(state.timers[k]));
  clearInterval(state.timers.clock);
  const { data, call } = state;
  if (sendBye && data && data.open) safe(() => data.send({ t: 'bye' }));
  state.data = null; state.call = null; state.partner = null; state.connectedAt = 0;
  setTimeout(() => { safe(() => data && data.close()); safe(() => call && call.close()); }, sendBye ? 300 : 0);
  el.remoteVideo.srcObject = null;
  el.typing.classList.add('hidden');
  el.partnerFlags.textContent = '';
}

function partnerLeft(reason) {
  if (!state.partner) return;
  cleanupPartner(false);
  addMsg('sys', reason);
  if (el.inAuto.checked) {
    state.searching = true;
    setUI('searching');
    state.timers.auto = setTimeout(() => {
      if (state.searching && !state.partner) lobbySend({ type: 'find' });
    }, 1500);
  } else {
    state.searching = false;
    setUI('idle');
    lobbySend({ type: 'stop' });
  }
}

function find() {
  if (!state.me) return;
  cleanupPartner(true);
  state.searching = true;
  setUI('searching');
  lobbySend({ type: 'find' });
}

function stop() {
  cleanupPartner(true);
  state.searching = false;
  setUI('idle');
  lobbySend({ type: 'stop' });
}

function blockPartner() {
  const p = state.partner;
  if (!p) return;
  if (!confirm(`¿Bloquear a ${p.name}? No volverá a tocarte en esta sesión.`)) return;
  state.blocked.add(p.id);
  lobbySend({ type: 'block', who: p.id });
  addMsg('sys', `Bloqueaste a ${p.name}.`);
  find();
}

/* ================= Interfaz ================= */
function updateSearchingHint() {
  const others = Math.max(0, state.stats.online - 1);
  el.overlaySub.textContent = others === 0
    ? 'Por ahora estás solo en la sala. ¡Invita a alguien con el botón 🔗 Invitar!'
    : `Hay ${others} persona${others === 1 ? '' : 's'} más en la sala.`;
}

function setUI(mode) {
  const connected = mode === 'connected';
  el.overlay.classList.toggle('hidden', connected);
  el.spinner.classList.toggle('hidden', mode === 'idle');
  el.partnerTag.classList.toggle('hidden', !connected);
  el.btnStop.disabled = mode === 'idle';
  el.btnBlock.disabled = !connected;
  el.inMsg.disabled = el.btnSend.disabled = !connected;
  el.quick.querySelectorAll('button').forEach((b) => { b.disabled = !connected; });
  el.btnNext.textContent = mode === 'idle' ? '▶ Empezar' : '⏭ Siguiente';
  el.overlaySub.textContent = '';
  if (mode === 'idle') {
    el.overlayText.innerHTML = 'Pulsa <b>Empezar</b> para conocer a alguien';
  } else if (mode === 'searching') {
    el.overlayText.textContent = `Buscando a alguien en #${state.sala}…`;
    updateSearchingHint();
  } else if (mode === 'connecting') {
    el.overlayText.textContent = `Conectando con ${state.partner.name}…`;
  } else if (connected) {
    el.partnerName.textContent = state.partner.name;
    el.timer.textContent = '00:00';
  }
}

function addMsg(kind, text) {
  const d = document.createElement('div');
  d.className = `msg ${kind}`;
  if (kind === 'me' || kind === 'them') {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = kind === 'me' ? 'Tú' : (state.partner ? state.partner.name : 'Extraño');
    d.append(who);
  }
  const t = document.createElement('span');
  t.textContent = text;
  d.append(t);
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
  u.searchParams.set('sala', state.sala || slug(el.inSala.value));
  return u.toString();
}

function openShare() {
  const url = shareUrl();
  el.shareLink.value = url;
  el.shareSala.textContent = `#${state.sala}`;
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

/* ================= Eventos ================= */
el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  state.name = clean(el.inName.value, 24) || randomNick();
  state.sala = slug(el.inSala.value);
  state.interests = parseInterests(el.inIntereses.value);
  storeSet('chispa:name', state.name);
  storeSet('chispa:interests', el.inIntereses.value);
  safe(() => { state.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); });

  const url = new URL(location.href);
  url.searchParams.set('sala', state.sala);
  history.replaceState(null, '', url);

  el.inicio.classList.add('hidden');
  el.app.classList.remove('hidden');
  el.lblSala.textContent = `#${state.sala}`;
  setUI('idle');
  await initMedia(el.inSoloTexto.checked);
  initPeer();
});

el.verNormas.addEventListener('click', (e) => { e.preventDefault(); el.dlgNormas.showModal(); });
document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

el.btnNext.addEventListener('click', find);
el.btnStop.addEventListener('click', stop);
el.btnMic.addEventListener('click', toggleMic);
el.btnCam.addEventListener('click', toggleCam);
el.btnFlip.addEventListener('click', flipCamera);
el.btnBlock.addEventListener('click', blockPartner);
el.btnShare.addEventListener('click', openShare);
el.btnCopy.addEventListener('click', copyLink);
el.btnNativeShare.addEventListener('click', () => {
  navigator.share({ title: 'Chispa', text: `¡Entra a mi sala #${state.sala} en Chispa!`, url: el.shareLink.value }).catch(() => {});
});

el.formChat.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = clean(el.inMsg.value, 500);
  if (!text) return;
  if (sendPeer({ t: 'msg', text })) { addMsg('me', text); el.inMsg.value = ''; }
});
el.inMsg.addEventListener('input', () => {
  if (Date.now() - state.lastTypingSent > 1500) { state.lastTypingSent = Date.now(); sendPeer({ t: 'typing' }); }
});

el.quick.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b === el.btnIce) {
    const i = Math.floor(Math.random() * ROMPEHIELOS.length);
    if (sendPeer({ t: 'ice', i })) addMsg('ice', `🎲 ${ROMPEHIELOS[i]}`);
  } else if (b.dataset.emoji && sendPeer({ t: 'react', e: b.dataset.emoji })) {
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
  if (state.data && state.data.open) safe(() => state.data.send({ t: 'bye' }));
  safe(() => state.lobbyPeer && state.lobbyPeer.destroy());
  safe(() => state.me && state.me.destroy());
});

/* ================= Arranque ================= */
(function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('sala')) el.inSala.value = params.get('sala');
  el.inName.value = storeGet('chispa:name') || '';
  el.inIntereses.value = storeGet('chispa:interests') || '';
  if (!window.Peer) {
    toast('No se pudo cargar PeerJS. Revisa tu conexión a internet.', 6000);
  }
})();
