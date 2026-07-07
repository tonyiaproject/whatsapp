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

Evolution API es open source (Apache 2.0) — no impone límite de instancias/números. Los límites
reales:

- **Recursos del servidor**: cada instancia Baileys mantiene una conexión WebSocket + estado en
  memoria. Un VPS modesto aguanta cómodamente 10-30 instancias; más que eso requiere más RAM/CPU o
  escalar horizontalmente (Evolution soporta Redis compartido/RabbitMQ para esto).
- **Base de datos**: Postgres crece con el historial de mensajes/contactos/chats.
- **Riesgo de baneo por WhatsApp**: inherente a cualquier número en modo no oficial
  (`WHATSAPP-BAILEYS`), independiente de cuántos números se tengan.
- **Alternativa oficial para escala real**: migrar números críticos a `WHATSAPP-BUSINESS` (Meta
  Cloud API oficial, también soportada por Evolution) — elimina el riesgo de baneo por
  automatización, a cambio del costo por conversación que cobra Meta.

## Fixes aplicados para correr esto en local (Docker Desktop / Windows)

- `docker-compose.yaml`: se agregó volumen que monta `Docker/nginx/manager-nginx.conf` sobre
  `/etc/nginx/conf.d/nginx.conf` del contenedor `frontend` — la imagen publicada
  `evoapicloud/evolution-manager:latest` trae un `gzip_proxied` con el valor inválido
  `must-revalidate`, lo que hacía crashear nginx en loop.
- Se creó la red externa `dokploy-network` (vacía) que el `docker-compose.yaml` referencia pero que
  solo aplica en despliegues con Dokploy.
- `.env`: se corrigió `CACHE_REDIS_URI` para apuntar al nombre del servicio Docker
  (`evolution-redis`) en vez de `localhost`.
