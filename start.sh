#!/bin/sh
set -e

echo "Starting Voice Journal Bot with Litestream backup..."

# Check if R2 credentials are set for Litestream
if [ -z "$R2_ACCOUNT_ID" ] || [ -z "$R2_ACCESS_KEY_ID" ] || [ -z "$R2_SECRET_ACCESS_KEY" ]; then
  echo "⚠ Warning: R2 credentials not set - Litestream backups disabled"
  echo "Starting bot without Litestream..."
  exec node index.js
else
  echo "✓ R2 credentials found - Litestream backups enabled"

  # Restore database from R2 if it doesn't exist locally and there's a backup
  if [ ! -f /data/voice-journal.db ]; then
    echo "No local database found, attempting to restore from R2..."
    litestream restore -if-replica-exists -config /etc/litestream.yml /data/voice-journal.db || echo "No backup found in R2, starting with fresh database"
  fi

  # Start Litestream in replicate mode (runs the command and replicates in background)
  echo "Starting bot with Litestream replication..."
  exec litestream replicate -config /etc/litestream.yml -exec "node index.js"
fi
