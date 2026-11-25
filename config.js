/*
 * Configuración de Chispa.
 *
 * TURN = un "puente" que retransmite la videollamada cuando dos personas están en redes que no
 * permiten conexión directa (datos móviles, Wi-Fi de colegios, etc.). Sin TURN, muchas parejas
 * en redes distintas NO logran conectarse.
 *
 * Opción A — Metered.ca (plan gratuito):
 *   1. Crea una cuenta en https://www.metered.ca/stun-turn y una "TURN app".
 *   2. Copia la URL de credenciales que te dan, del tipo:
 *      https://TU-APP.metered.live/api/v1/turn/credentials?apiKey=TU_API_KEY
 *   3. Pégala abajo en `meteredUrl`.
 *
 * Opción B — servidores TURN con usuario y contraseña fijos (por ejemplo ExpressTURN):
 *   turnServers: [{ urls: 'turn:SERVIDOR:3478', username: 'USUARIO', credential: 'CLAVE' }]
 *
 * Nota: estas credenciales quedan visibles en la página (así funciona WebRTC en el navegador).
 * En Metered puedes limitar la clave a tu dominio (corenaa0.github.io) desde su panel.
 */
window.CHISPA_CONFIG = {
  meteredUrl: 'https://chispa.metered.live/api/v1/turn/credentials?apiKey=5c539f49ef27b70193ac93b853786276ac33',
  turnServers: [],
};
