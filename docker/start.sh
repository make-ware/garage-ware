#!/bin/sh
set -e

# Ensure /data/pb_data exists and is writable by the nextjs user whether or not
# a host bind-mount was used (Docker creates bind-mount dirs as root).
mkdir -p /data/pb_data
chown -R nextjs:nodejs /data

echo "Starting services with Supervisor..."
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf



