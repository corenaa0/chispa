# ⚡ Chispa — videochat aleatorio con tu clase

Una app tipo "ruleta de videochat", pero pensada para usar **entre compañeros**: entras a una
**sala** con un código, compartes el enlace y la app te empareja al azar con otra persona de esa sala.

## Qué problema resuelve

Las apps de videochat aleatorio te conectan con desconocidos de todo el mundo, sin control.
Chispa mantiene la parte divertida (no sabes con quién te va a tocar) pero **solo dentro de tu grupo**,
con normas de convivencia y un botón para bloquear.

## Funciones

- 🎥 Videollamada directa entre navegadores (WebRTC, nada pasa por un servidor propio ni se graba).
- 👥 **Llamadas en grupo**: eliges con cuántas personas hablar a la vez (2 = 1 a 1, hasta 8). Solo te unimos con
  quienes eligieron el mismo número; el grupo empieza con 2 y los demás van llegando hasta llenarlo.
  También se puede abrir directo con `?grupo=4` en el enlace.
- 🌎 **Sala pública por defecto**: si no pones código de sala, te emparejamos al azar con todos los conectados.
- 🚪 Salas privadas opcionales por código: `?sala=mi-clase` en el enlace.
- 🎭 El nombre también es opcional: si lo dejas vacío te asignamos un apodo al azar.
- 🔗 Botón **Invitar** con enlace para copiar, compartir nativo en el móvil y **código QR**.
- 🎯 Emparejamiento por **intereses en común** (y evita repetir con la misma persona).
- ⏭ **Siguiente** (o tecla `Esc`), ⏹ Detener y modo **Auto** (busca a otra persona si la actual se va).
- 💬 Chat de texto con indicador "escribiendo…".
- 🎲 **Rompehielos**: pregunta al azar para romper el silencio.
- 😂 Reacciones con emojis que flotan sobre el video.
- 🎤📷 Silenciar micrófono / apagar cámara (el otro ve el estado), 🔄 cambiar de cámara en el móvil.
- 🙈 **Modo sin cámara**: entras con un avatar animado.
- 🚫 Bloquear (botón sobre el video de cada persona): esa persona ya no te vuelve a tocar en la sesión.
- 👥 Contador de personas en la sala y cuántas están buscando.

## Cómo funciona por dentro

- Archivos estáticos: `index.html`, `style.css`, `app.js`. No hay backend.
- [PeerJS](https://peerjs.com/) usa su servidor público gratuito solo para que los navegadores "se presenten";
  el video y el chat viajan directo entre ellos.
- El primer navegador que entra a una sala se convierte en **anfitrión** (👑 en la barra superior) y hace de
  emparejador. Si se va, otro toma el relevo automáticamente.

## Probarlo en tu computador

La cámara solo funciona en `https://` o en `localhost`. Cualquier servidor estático sirve, por ejemplo:

```bash
npx serve .
```

o con Python: `python -m http.server 8000`, y abre `http://localhost:8000/?sala=prueba` en dos pestañas.

## Publicarlo en GitHub Pages (para compartir el enlace)

1. Crea un repositorio nuevo en GitHub (por ejemplo `chispa`).
2. Sube estos archivos:
   ```bash
   git remote add origin https://github.com/TU-USUARIO/chispa.git
   git push -u origin main
   ```
3. En GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)`** → Save.
4. En 1–2 minutos tendrás el enlace: `https://TU-USUARIO.github.io/chispa/?sala=mi-clase`. ¡Compártelo!

## Limitaciones conocidas

- Algunas redes muy cerradas (ciertos Wi-Fi de colegios/empresas) bloquean conexiones directas. Para esos casos
  haría falta un servidor TURN (por ejemplo, el plan gratuito de Metered o Twilio).
- Si el anfitrión deja la pestaña en segundo plano en el móvil mucho tiempo, el emparejamiento puede tardar
  hasta que otro navegador tome el relevo.
- El bloqueo dura solo la sesión (no hay cuentas de usuario).

## Ideas para seguir

- Inicio de sesión con GitHub (Firebase Auth o Supabase) para tener perfiles y bloqueos permanentes.
- Modo "juego": preguntas de trivia o retos en pareja con puntaje.
- Salas temáticas visibles (lista de salas activas).
- Panel del profesor: ver cuántos hay conectados y cerrar la sala.
- Instalable como app en el teléfono (PWA).
