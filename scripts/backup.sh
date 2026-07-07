#!/bin/bash
# Creates a full backup of the local stack (database + secrets + WhatsApp session volume)
# so it can be restored on another machine (e.g. the production VPS).
#
# Usage: ./scripts/backup.sh
# Run from the repo root, with the stack currently running (docker compose up -d).

set -e
export MSYS_NO_PATHCONV=1  # avoid Git Bash mangling host paths passed to `docker run -v` on Windows

cd "$(dirname "$0")/.."

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="./backups/backup_$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

echo "==> Volcando base de datos Postgres..."
docker exec evolution_postgres pg_dump -U evolution -d evolution_db > "$BACKUP_DIR/evolution_db.sql"

echo "==> Copiando archivos .env (contienen secretos, protege esta carpeta)..."
cp .env "$BACKUP_DIR/root.env"
cp claude-bridge/.env "$BACKUP_DIR/claude-bridge.env"

echo "==> Respaldando volumen de instancias de WhatsApp (evolution_instances)..."
FULL_VOLUME=$(docker volume ls --format '{{.Name}}' | grep -i "evolution_instances" | head -1)
if [ -n "$FULL_VOLUME" ]; then
  docker run --rm -v "$FULL_VOLUME":/data -v "$(pwd)/$BACKUP_DIR":/backup alpine \
    sh -c "cd /data && tar czf /backup/evolution_instances.tar.gz ."
  echo "    Volumen respaldado: $FULL_VOLUME"
else
  echo "    ADVERTENCIA: no se encontro el volumen evolution_instances, se omite."
fi

echo ""
echo "==> Backup completo en: $BACKUP_DIR"
echo "    Copia esta carpeta COMPLETA al VPS (scp, sftp, o USB) de forma segura -- contiene secretos."
echo "    En el VPS, dentro del repo clonado, corre: ./scripts/restore.sh $BACKUP_DIR"
