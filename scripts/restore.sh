#!/bin/bash
# Restores a backup created by scripts/backup.sh onto a fresh machine (the VPS).
#
# Usage: ./scripts/restore.sh /path/to/backup_folder
# Run from the repo root, AFTER cloning the repo and BEFORE the first `docker compose up -d`.
# Requires Docker + Docker Compose already installed.

set -e
export MSYS_NO_PATHCONV=1  # no-op on real Linux; avoids Git Bash path mangling if ever run on Windows

cd "$(dirname "$0")/.."

BACKUP_DIR="$1"
if [ -z "$BACKUP_DIR" ] || [ ! -d "$BACKUP_DIR" ]; then
  echo "Uso: ./scripts/restore.sh /ruta/a/backup_YYYYMMDD_HHMMSS"
  exit 1
fi

echo "==> Restaurando archivos .env..."
cp "$BACKUP_DIR/root.env" .env
cp "$BACKUP_DIR/claude-bridge.env" claude-bridge/.env

echo "==> Creando red externa dokploy-network (placeholder, no aplica fuera de Dokploy)..."
docker network create dokploy-network 2>/dev/null || echo "    (ya existia)"

echo "==> Levantando solo Postgres para poder restaurar la base de datos..."
docker compose up -d evolution-postgres
echo "    Esperando a que Postgres este listo..."
sleep 8

echo "==> Restaurando base de datos..."
docker exec -i evolution_postgres psql -U evolution -d evolution_db < "$BACKUP_DIR/evolution_db.sql"

if [ -f "$BACKUP_DIR/evolution_instances.tar.gz" ]; then
  echo "==> Restaurando volumen de instancias de WhatsApp..."
  PROJECT_NAME=$(basename "$(pwd)")
  VOLUME_NAME="${PROJECT_NAME}_evolution_instances"
  docker volume create "$VOLUME_NAME" >/dev/null
  docker run --rm -v "$VOLUME_NAME":/data -v "$(cd "$BACKUP_DIR" && pwd)":/backup alpine \
    sh -c "cd /data && tar xzf /backup/evolution_instances.tar.gz"
else
  echo "==> No hay volumen de instancias en el backup, se omite (no habia datos que respaldar)."
fi

echo "==> Levantando el resto del stack (API, frontend, redis, claude-bridge)..."
docker compose up -d --build claude-bridge
docker compose up -d

echo ""
echo "==> Restauracion completa."
echo "    Verifica en http://<IP-DEL-VPS>:8080 (API) y http://<IP-DEL-VPS>:3000 (Manager)."
echo "    Es MUY probable que necesites volver a escanear el QR de WhatsApp para cada instancia"
echo "    (revisa /instance/connectionState/<nombre> -- si dice 'close', hay que reconectar)."
echo ""
echo "    IMPORTANTE: el puerto 3000 (Manager) queda expuesto a TODO internet por defecto."
echo "    Antes de dejarlo en produccion, configura un firewall (ufw) o restringe el acceso"
echo "    -- ver docs/migracion-a-vps.md, seccion 'Seguridad en el VPS'."
