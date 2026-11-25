/*
 * Configuración de Chispa.
 *
 * ── TURN ─────────────────────────────────────────────────────────────
 * Un "puente" que retransmite la videollamada cuando dos personas están en redes que no
 * permiten conexión directa (datos móviles, Wi-Fi de colegios, etc.).
 *   Opción A — Metered.ca: pega en `meteredUrl` la URL de credenciales de tu app.
 *   Opción B — servidores fijos: turnServers: [{ urls: 'turn:SERVIDOR:3478', username: 'U', credential: 'C' }]
 *
 * ── Moderación (Supabase) ────────────────────────────────────────────
 * Reportes con captura, registro de IP al entrar, bloqueos y el panel /admin.
 *   1. Crea un proyecto gratis en https://supabase.com
 *   2. SQL Editor → pega y ejecuta el archivo supabase.sql
 *   3. Project Settings → API: copia "Project URL" y la clave "anon public" aquí abajo.
 * La clave "anon" es pública por diseño (las tablas están protegidas con reglas de seguridad).
 * NUNCA pongas aquí la clave "service_role".
 *
 * Nota: estas claves quedan visibles en la página (así funciona en el navegador).
 */
window.CHISPA_CONFIG = {
  meteredUrl: 'https://chispa.metered.live/api/v1/turn/credentials?apiKey=5c539f49ef27b70193ac93b853786276ac33',
  turnServers: [],

  supabaseUrl: '',
  supabaseKey: '',
};
