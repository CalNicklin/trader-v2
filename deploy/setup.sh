#!/bin/bash
# Run this once on a fresh Hetzner VPS to set up trader-v2
# Usage: ssh deploy@your-vps 'bash -s' < deploy/setup.sh
set -e

echo "=== Installing Bun ==="
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

echo "=== Cloning repo ==="
sudo mkdir -p /opt/trader-v2
sudo chown $USER:$USER /opt/trader-v2
git clone https://github.com/CalNicklin/trader-v2.git /opt/trader-v2
cd /opt/trader-v2

echo "=== Installing dependencies ==="
bun install

echo "=== Creating data directory ==="
mkdir -p /opt/trader-v2/data

echo "=== Creating .env file ==="
cat > /opt/trader-v2/.env << 'ENVEOF'
ANTHROPIC_API_KEY=
RESEND_API_KEY=
ALERT_EMAIL_FROM=trader@mail.tracesknown.com
ALERT_EMAIL_TO=calpnicklin@gmail.com
GITHUB_TOKEN=
GITHUB_REPO_OWNER=CalNicklin
GITHUB_REPO_NAME=trader-v2
DB_PATH=/opt/trader-v2/data/trader.db
LOG_LEVEL=info
NODE_ENV=production
DAILY_API_BUDGET_USD=0
FINNHUB_API_KEY=
ENVEOF

echo ">>> IMPORTANT: Edit /opt/trader-v2/.env and fill in API keys <<<"

echo "=== Installing systemd service ==="
sudo cp /opt/trader-v2/deploy/trader-v2.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable trader-v2

echo "=== Running migrations ==="
cd /opt/trader-v2
bun run db:migrate

echo "=== Done! ==="
echo "Fill in /opt/trader-v2/.env then run: sudo systemctl start trader-v2"
