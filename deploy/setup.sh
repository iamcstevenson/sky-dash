#!/usr/bin/env bash
# One-time server setup for Ubuntu 24.04. Run as root; safe to run again.
# Installs Node 24, creates the skydash user, checks out the code and installs the service.
# Afterwards: put settings in /opt/skydash/.env (see .env.example), then `systemctl start skydash`.
set -euo pipefail

REPO=${REPO:-https://github.com/iamcstevenson/sky-dash.git}

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y git sqlite3 rclone

id skydash >/dev/null 2>&1 || useradd --system --home-dir /opt/skydash --shell /usr/sbin/nologin skydash
install -d -o skydash -g skydash -m 750 /var/lib/skydash
if [ ! -d /opt/skydash/.git ]; then
  install -d -o skydash -g skydash -m 755 /opt/skydash
  sudo -u skydash git clone "$REPO" /opt/skydash
fi
sudo -u skydash bash -c 'cd /opt/skydash && npm ci --omit=dev --no-audit --no-fund --cache /tmp/skydash-npm-cache'

for unit in skydash.service skydash-backup.service skydash-backup.timer skydash-update.service skydash-update.timer; do
  install -m 644 "/opt/skydash/deploy/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable skydash
systemctl enable --now skydash-backup.timer skydash-update.timer
echo "Setup done. Next: create /opt/skydash/.env (owner skydash, mode 600), then: systemctl start skydash"
echo "Backups need the rclone remotes r2 and skydash-crypt in /root/.config/rclone/rclone.conf (see docs/architecture.md)."
