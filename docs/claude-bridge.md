# Integración con Claude Haiku (claude-bridge)

Este proyecto conecta la instancia de WhatsApp (Evolution API) con Claude Haiku 4.5 a través de un
servicio propio (`claude-bridge/`), usando la integración nativa `EvolutionBot` de Evolution API
(un webhook genérico: Evolution le manda cada mensaje entrante a una URL y espera `{"message": "..."}`
de vuelta).

## Componentes

- `claude-bridge/server.js` — servidor Express que recibe el webhook, llama a la API de Anthropic
  (modelo `claude-haiku-4-5-20251001`) y responde.
- `claude-bridge/.env` — credenciales y configuración (no se sube a git, cubierto por `*.env` en `.gitignore`).
- Servicio `claude-bridge` en `docker-compose.yaml`, en la misma red (`evolution-net`) que la API.
- Bot `EvolutionBot` creado vía API en la instancia `Tony`, apuntando a `http://claude-bridge:3001/webhook`.

## Comportamiento del bridge

1. **Primer mensaje de un contacto nuevo**: responde con un saludo fijo (`WELCOME_MESSAGE` en `.env`),
   sin llamar a Claude — determinista y gratis.
2. **Mensajes siguientes**: se le pasan a Claude Haiku con el `SYSTEM_PROMPT` configurado (personalidad
   "TonyIA"), manteniendo un historial en memoria por contacto (máx. 20 mensajes, se resetea si el
   contenedor se reinicia — no hay persistencia en base de datos todavía).
3. **Frases de traspaso a humano** (ej. "hablar con Tony", "hablar con un humano"): el bridge detecta
   estas frases (coincidencia de texto, sin acentos, insensible a mayúsculas), responde un mensaje corto
   y llama de vuelta a la API de Evolution (`POST /evolutionBot/changeStatus/:instance`) para cerrar el
   bot en esa conversación — no vuelve a responder ahí hasta que el usuario relance el flujo.
4. **Si Tony escribe manualmente** desde su propio WhatsApp en una conversación activa del bot, este se
   pausa automáticamente — esto es un comportamiento **nativo de Evolution API** (`stopBotFromMe: true`
   en la configuración del bot), no algo que implementamos en el bridge.
5. **Los grupos de WhatsApp están completamente excluidos**: los ajustes del bot (`ignoreJids: ["@g.us"]`,
   ver `POST /evolutionBot/settings/:instance`) hacen que Evolution API descarte cualquier mensaje de
   grupo antes de buscar el bot — el bridge nunca llega a recibir esos mensajes. Sin esto, el bot
   respondería en cualquier grupo donde esté agregado el número, algo no deseado en pruebas ni en
   producción.

## Variables de entorno (`claude-bridge/.env`)

| Variable | Uso |
|---|---|
| `ANTHROPIC_API_KEY` | API key de Anthropic |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` |
| `CLAUDE_MAX_TOKENS` | Tope de tokens de salida por respuesta (actualmente `120`, para forzar respuestas cortas) |
| `SYSTEM_PROMPT` | Personalidad/reglas de TonyIA |
| `WELCOME_MESSAGE` | Saludo fijo para el primer contacto |
| `HANDOFF_MESSAGE` | Mensaje al detectar traspaso a humano |
| `EVOLUTION_API_URL` | URL interna de la API dentro de la red Docker (`http://api:8080`) |
| `EVOLUTION_API_KEY` | API key global de Evolution, usada para cerrar sesiones de bot vía `changeStatus` |
| `MIN_REPLY_DELAY_MS` / `MAX_REPLY_DELAY_MS` | Rango (ms) de espera aleatoria antes de responder cada mensaje (por defecto 2000-8000) |

## Costos (Claude Haiku 4.5)

Precio vigente (referencia jun-2026): **$1.00 / millón de tokens de entrada**, **$5.00 / millón de
tokens de salida**.

Como el bridge no usa *prompt caching*, en cada mensaje se reenvía el `system prompt` completo
(~180 tokens) más el historial acumulado de la conversación (hasta 20 mensajes). Estimado:

- Mensaje de bienvenida: $0 (no llama a Claude).
- Mensajes tempranos de una conversación (poco historial): ~$0.0005 por mensaje.
- Mensajes tardíos (historial lleno, ~20 mensajes): ~$0.001-0.0013 por mensaje.
- **Conversación completa de ~10 idas y vueltas: ~$0.005-0.01 USD.**

Con $10 USD de crédito, esto alcanza tranquilamente para varios miles de mensajes en volumen de
pruebas/uso moderado. Si el volumen crece mucho, la primera optimización sería activar *prompt
caching* sobre el `system prompt` (ahorro ~10-15% en conversaciones largas).

## WhatsApp: palomitas de lectura (read receipts)

La instancia tiene `readMessages: false` por defecto — por eso no se marcan las dos palomitas
azules cuando alguien escribe. Es una casilla de configuración (`POST /settings/set/:instance`),
no un bug. Activarla hace que el bot se comporte de forma más creíble (lee antes de responder),
aunque no hay evidencia oficial de que la ausencia de palomitas azules por sí sola dispare
detección de automatización por parte de Meta — muchos usuarios reales desactivan esa opción sin
ningún problema. Los factores de riesgo reales para números en modo `WHATSAPP-BAILEYS` (no oficial)
son otros: mensajes masivos idénticos, velocidad de respuesta sobrehumana constante, iniciar muchas
conversaciones no solicitadas, actividad 24/7 sin variación, o tasa alta de bloqueos/reportes.

## Escalar a producción — límites y consideraciones

Evolution API es open source (Apache 2.0) — no impone límite de instancias/números. Un solo
contenedor de la API (proceso Node.js, sin clustering) puede manejar muchas instancias/números a la
vez — no es "un contenedor por número", cada instancia es solo una conexión WebSocket + estado en
memoria dentro del mismo proceso.

Con el hardware de referencia usado en pruebas (12 CPUs, ~7.6 GB RAM asignados a Docker Desktop; 1
instancia activa consumía ~157 MB en el contenedor de la API):

- **RAM** es normalmente el cuello de botella, no CPU: con ~50-100 MB por instancia bajo actividad
  moderada, ese hardware soporta cómodamente **~30-60 números** con margen de operación, y
  técnicamente hasta ~60-90 antes de agotar RAM — pero probarlo con tráfico real antes de prometerle
  esa capacidad a clientes.
- **CPU**: al ser un solo proceso Node sin clustering, el límite real aparece con volumen de
  mensajes *simultáneos*, no con números inactivos.
- **Base de datos**: Postgres ya está configurado para hasta 1000 conexiones — no es el cuello de
  botella típico a esta escala.
- **Para escalar más allá de un servidor**: Evolution soporta correr varias réplicas de la API
  compartiendo el mismo Redis/Postgres (el `docker-compose.yaml` ya tiene alias de red pensados para
  esto).
- **No correr esto en una computadora personal para producción real** — para comercializarlo se
  necesita un servidor (VPS/cloud) dedicado, dimensionado según el número de clientes/números
  activos.
- **Alternativa oficial para escala real**: migrar números críticos a `WHATSAPP-BUSINESS` (Meta
  Cloud API oficial, también soportada por Evolution) — elimina el riesgo de baneo por
  automatización, a cambio del costo por conversación que cobra Meta.

### Riesgo de baneo — caso de uso solo-entrada (sin mensajes salientes)

Este servicio está pensado únicamente para **responder mensajes entrantes** (nadie recibe mensajes
no solicitados de parte del bot; solo contesta a quien escribe primero). Esto reduce
significativamente el riesgo de baneo, porque elimina el factor de riesgo más común y mejor
documentado en la comunidad de Baileys: el envío masivo de mensajes no solicitados (spam saliente,
campañas a números que nunca escribieron primero).

Sin embargo, el riesgo **no es cero**:

- Sigue siendo un cliente no oficial (Baileys reconstruye el protocolo de WhatsApp Web por
  ingeniería inversa) — los términos de servicio de WhatsApp prohíben clientes no autorizados
  independientemente de si el número envía o solo responde.
- El propio patrón de respuesta puede delatar automatización: contestar siempre en 1-2 segundos,
  las 24 horas, sin ninguna variación, es un patrón detectable como no-humano — más visible cuantos
  más números se comporten igual.

Mitigaciones ya aplicadas en este proyecto:

- **Delay de respuesta aleatorio** (`MIN_REPLY_DELAY_MS` / `MAX_REPLY_DELAY_MS` en
  `claude-bridge/.env`, por defecto 2000-8000 ms): el bridge espera un tiempo random dentro de ese
  rango antes de devolver la respuesta a Evolution, para cada mensaje — así el tiempo de respuesta
  nunca es idéntico ni instantáneo. Se suma al `delayMessage`/`debounceTime` propios de Evolution
  (indicador de "escribiendo...").
- `readMessages: true` / `readStatus: true` activados — el bot marca los mensajes como leídos, lo
  que se ve más creíble/humano.
- Las respuestas de Claude ya varían de forma natural en tono y redacción (no son plantillas fijas
  repetidas).

## Branding del panel Manager (localhost:3000) — "Humania"

> Nota: el panel pasó por dos nombres antes de este — primero "TonyIA Manager", ahora **"Humania"**
> (proyecto de marca propio del usuario, tagline "la IA que automatiza tu negocio"). El mecanismo de
> reemplazo es el mismo cada vez; solo cambian los archivos de logo y las cadenas de texto.

La imagen `evoapicloud/evolution-manager:latest` sirve archivos estáticos con nginx desde
`/usr/share/nginx/html`. Hay **dos logos distintos** en juego, y solo uno de ellos es el que
realmente se ve en pantalla:

- `assets/images/evolution-logo.png` (965×363 px): usado como ícono cuadrado de respaldo (32×32,
  clase `h-8 w-8`) cuando una instancia no tiene foto de perfil — poco visible en el uso normal.
- El **logo principal** (pantalla de login, encabezados) viene de una **URL externa fija dentro del
  JS compilado**: `https://evolution-api.com/files/evo/evolution-logo.svg` (tema claro) /
  `evolution-logo-white.svg` (tema oscuro). No hay ninguna variable de entorno para cambiar esto —
  está hardcodeado en el bundle `assets/index-CO3NSIFj.js`.

### Cómo se reemplazó

1. Se extrajo el JS del contenedor, se reemplazaron esas dos URLs por rutas locales
   (`/assets/images/tony-logo-light.png` y `/assets/images/tony-logo-dark.png`) con `sed`, y el
   archivo resultante se guardó en `Docker/nginx/index-CO3NSIFj.js`.
2. Se copiaron los wordmarks de Humania (`umania negros_.png` → tema claro, `umania blanco.png` →
   tema oscuro, ambos en `D:\CLIENTES\UMANIA\`) a `Docker/nginx/tony-logo-light.png` /
   `tony-logo-dark.png` (se mantuvieron los nombres de archivo originales para no tocar
   `docker-compose.yaml`).
3. Del wordmark negro se recortó automáticamente (script Python + Pillow, por proporción del ancho
   del contenido) solo el ícono morado de la persona integrada en "ia" — se usa para el avatar
   cuadrado de respaldo (`evolution-logo.png`) y el favicon, donde el wordmark completo no cabía
   legible.
4. Se reemplazó el texto del producto ("Evolution Manager" → "TonyIA Manager" → ahora **"Humania"**)
   en título de pestaña, encabezados y pantalla de login en 4 idiomas, y el subtítulo pasó a ser
   **"La IA que automatiza tu negocio"** — editando el mismo JS y `Docker/nginx/index.html`.
5. El favicon (`<link rel="icon">` en `index.html`) se generó a partir del ícono morado recortado
   (128×128 sobre fondo transparente) y se cambió el `href` a `/favicon.png`.
6. Todo se monta sobre los archivos originales del contenedor vía `docker-compose.yaml`:

```yaml
volumes:
  - ./Docker/nginx/evolution-logo.png:/usr/share/nginx/html/assets/images/evolution-logo.png:ro
  - ./Docker/nginx/index-CO3NSIFj.js:/usr/share/nginx/html/assets/index-CO3NSIFj.js:ro
  - ./Docker/nginx/tony-logo-light.png:/usr/share/nginx/html/assets/images/tony-logo-light.png:ro
  - ./Docker/nginx/tony-logo-dark.png:/usr/share/nginx/html/assets/images/tony-logo-dark.png:ro
  - ./Docker/nginx/index.html:/usr/share/nginx/html/index.html:ro
  - ./Docker/nginx/favicon.png:/usr/share/nginx/html/favicon.png:ro
```

**Frágil ante actualizaciones**: si se actualiza la imagen `evoapicloud/evolution-manager` a una
versión nueva, el nombre del archivo JS cambia (el hash `CO3NSIFj` es del build actual) y este patch
se rompe silenciosamente — el mount fallaría o el JS parchado quedaría desactualizado. Si se
actualiza la imagen, hay que repetir el proceso de extracción + `sed` con el nuevo archivo.

Se dejaron sin tocar, a propósito, dos textos que sí mencionan "Evolution API": el aviso de
copyright/licencia en el pie de página, y un enlace de "ayuda / conoce más sobre Evolution API" —
ver la sección de licencia y marca abajo para el porqué.

### Licencia y política de marca — ¿esto rompe alguna regla?

El código es Apache 2.0 (`LICENSE`), así que modificarlo es libre. Pero el repo también trae un
`TRADEMARKS.md` con la política de marca de Evolution Foundation, y es directamente relevante para
este proyecto porque se planea comercializar:

- Sección 4.1: si usas su logo/marca **sin modificarlo**, no puedes alterarlo.
- Sección 4.2: si distribuyes/alojas públicamente una **interfaz modificada**, debes (a) quitar y
  reemplazar toda su marca — incluyendo el nombre del producto mostrado — y (b) usar un nombre y
  marca claramente distintos de "Evolution API".

Es decir, reemplazar el logo y el nombre (lo que se hizo aquí) es exactamente lo que su propia
política **exige** al distribuir/alojar una versión personalizada — no una violación. Por eso se
mantuvo intacta la línea de copyright/licencia (atribución legal real, no "marca") y el enlace
nominativo genuino a "Evolution API" en la sección de ayuda (permitido explícitamente por la
sección 2.1: se puede referir con veracidad al proyecto del que deriva el software).

Nota: esto es una lectura del documento público del proyecto, no asesoría legal formal — si el
negocio crece en serio, vale la pena una revisión legal real, tanto de esto como de los términos de
uso de WhatsApp/Meta mencionados arriba.

## Fixes aplicados para correr esto en local (Docker Desktop / Windows)

- `docker-compose.yaml`: se agregó volumen que monta `Docker/nginx/manager-nginx.conf` sobre
  `/etc/nginx/conf.d/nginx.conf` del contenedor `frontend` — la imagen publicada
  `evoapicloud/evolution-manager:latest` trae un `gzip_proxied` con el valor inválido
  `must-revalidate`, lo que hacía crashear nginx en loop.
- Se creó la red externa `dokploy-network` (vacía) que el `docker-compose.yaml` referencia pero que
  solo aplica en despliegues con Dokploy.
- `.env`: se corrigió `CACHE_REDIS_URI` para apuntar al nombre del servicio Docker
  (`evolution-redis`) en vez de `localhost`.

### Troubleshooting: error "mkdir /run/desktop/mnt/host/...: file exists"

Bug conocido de Docker Desktop en Windows: su caché interna de carpetas compartidas (VirtioFS/
gRPC-FUSE) se puede corromper al agregar/quitar bind mounts de archivos individuales, y entonces
cualquier contenedor con ese tipo de mount deja de arrancar (se queda en estado `Created`). Se
soluciona reiniciando Docker Desktop (clic derecho en el ícono de la barra de tareas → Restart).
