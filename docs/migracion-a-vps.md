# Migración de local a VPS (Hostinger KVM 2 u otro)

Checklist y scripts para pasar este stack de la máquina local a un VPS, sin perder historial,
contactos ni configuración de bots.

## Qué se preserva vs qué hay que rehacer

| Dato | ¿Se preserva? | Dónde vive |
|---|---|---|
| Historial de mensajes, contactos, chats | ✅ Sí | Postgres (`evolution_db`) |
| Bots configurados (EvolutionBot, ajustes, ignoreJids, etc.) | ✅ Sí | Postgres |
| Credenciales (`.env`, API keys) | ✅ Sí, pero manual | No están en git — se copian a mano |
| Conexión activa de WhatsApp (sesión) | ⚠️ Probablemente no | Ver nota abajo |

**Nota sobre la sesión de WhatsApp**: al momento de escribir esto, la instancia "Tony" ya estaba
desconectada (`LOGOUT`) por razones ajenas a la migración — WhatsApp puede cerrar la sesión sin
aviso, en local o en VPS por igual. Sea que migres hoy o en una semana, **hay que contar con volver
a escanear el QR** al reconectar cada número. El script de restauración intenta preservar el volumen
`evolution_instances` por si en el futuro sí guarda datos de sesión reutilizables, pero no des por
hecho que la reconexión será automática.

## Paso 1 — Respaldar en la máquina local

Con el stack corriendo (`docker compose up -d`), desde la raíz del repo:

```bash
./scripts/backup.sh
```

Esto crea `backups/backup_<fecha>/` con:
- `evolution_db.sql` — volcado completo de Postgres
- `root.env` y `claude-bridge.env` — copias de tus archivos de configuración/secretos
- `evolution_instances.tar.gz` — volumen de sesión de WhatsApp (si tiene contenido)

**Esta carpeta contiene secretos (API keys). Cópiala al VPS de forma segura** (scp/sftp sobre SSH,
nunca por correo o chat sin cifrar), y no la subas a git.

## Paso 2 — Preparar el VPS

1. Crear el VPS (Hostinger KVM 2 recomendado — ver `docs/claude-bridge.md` para el análisis de
   tamaño).
2. Instalar Docker y Docker Compose (Ubuntu, el más común en Hostinger):
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER   # cierra sesión y vuelve a entrar para que aplique
   ```
   Docker Compose v2 ya viene incluido con el script anterior (`docker compose`, sin guion).
3. Clonar el repo **en una carpeta llamada exactamente `open_whatsaap`** (así los nombres de
   volúmenes/red de Docker Compose coinciden con los que genera el script de respaldo):
   ```bash
   git clone https://github.com/tonyiaproject/whatsapp.git open_whatsaap
   cd open_whatsaap
   ```
4. Subir la carpeta de backup al VPS (ej. `scp -r backups/backup_20260707_120000 usuario@IP-VPS:~/open_whatsaap/backups/`).

## Paso 3 — Restaurar

Desde la raíz del repo clonado en el VPS:

```bash
./scripts/restore.sh backups/backup_20260707_120000
```

El script:
1. Copia los `.env` a su lugar.
2. Crea la red `dokploy-network` (placeholder, no se usa fuera de Dokploy).
3. Levanta Postgres y restaura el volcado de la base de datos.
4. Restaura el volumen de instancias de WhatsApp si el backup lo trae.
5. Construye y levanta el resto del stack (`claude-bridge` necesita `--build` porque su imagen no
   se sube a un registry, se construye localmente desde `claude-bridge/Dockerfile`).

## Paso 4 — Reconectar WhatsApp y verificar

1. Revisa el estado de cada instancia: `curl http://localhost:8080/instance/connectionState/<nombre> -H "apikey: <tu-key>"`.
2. Si dice `"close"`, genera un QR nuevo desde el Manager (`http://IP-VPS:3000`) y reconecta desde
   el teléfono.
3. Prueba el flujo completo: manda un mensaje de WhatsApp y confirma que Humania responde.

## Seguridad en el VPS — antes de dejarlo en producción

El `docker-compose.yaml` actual expone el puerto del Manager (`3000`) a **todas las interfaces**, no
solo localhost (a diferencia de la API, que ya está limitada a `127.0.0.1:8080`). En tu máquina
local eso no importa porque nadie fuera de tu red puede llegar a `localhost:3000`. **En un VPS con
IP pública, cualquiera en internet podría llegar a `http://IP-VPS:3000` sin restricción alguna.**

Antes de considerar esto "en producción", hay que hacer al menos una de estas dos cosas:

1. **Firewall (rápido, recomendado para empezar)**: usar `ufw` para permitir el puerto 3000 solo
   desde tu IP:
   ```bash
   sudo ufw allow from TU_IP_PUBLICA to any port 3000
   sudo ufw allow 22/tcp    # no te quedes fuera por SSH
   sudo ufw enable
   ```
2. **Sin exponer el puerto en absoluto (más seguro, un poco más de fricción)**: cambiar
   `"3000:80"` por `"127.0.0.1:3000:80"` en `docker-compose.yaml`, y acceder al Manager vía túnel
   SSH (`ssh -L 3000:localhost:3000 usuario@IP-VPS`) cuando lo necesites.

Para algo más permanente y con dominio propio (ej. `panel.humania.com`), lo ideal a mediano plazo es
poner un reverse proxy (Caddy o nginx) delante con HTTPS y, si se puede, autenticación adicional —
no es urgente para los primeros clientes piloto, pero sí antes de escalar en serio.
