#!/usr/bin/env bash
# One-shot VPS setup for Bazaar on the SciScribe Hetzner box (Ubuntu 24.04, Docker + PM2 + Caddy already present).
# Usage: bash deploy/setup-vps.sh            (run from the repo root, as the deploy user)
# Idempotent: safe to re-run after git pull.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== toolchain"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "   upgrading Node $NODE_MAJOR -> 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  apt-get install -y nodejs
  npm i -g pm2 pnpm
  pm2 update   # respawn the PM2 daemon and existing apps on the new runtime
fi
command -v pnpm >/dev/null || npm i -g pnpm
command -v pm2 >/dev/null || npm i -g pm2
node -v

echo "== .env"
if [ ! -f .env ]; then
  cp .env.example .env
  gen() { node -e "console.log(require('crypto').randomBytes($1).toString('base64url'))"; }
  sed -i "s|^BAZAAR_API_TOKEN=.*|BAZAAR_API_TOKEN=$(gen 32)|" .env
  sed -i "s|^TOKEN_ENC_KEY=.*|TOKEN_ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")|" .env
  sed -i "s|^WHATSAPP_WEBHOOK_SECRET=.*|WHATSAPP_WEBHOOK_SECRET=$(gen 32)|" .env
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgres://bazaar:bazaar@127.0.0.1:5433/bazaar|" .env
  sed -i "s|^BAZAAR_SUPPLIERS=.*|BAZAAR_SUPPLIERS=instamart|" .env
  echo "   wrote .env with fresh secrets. ANTHROPIC_API_KEY still needs to be set."
fi
grep -q '^ANTHROPIC_API_KEY=sk-' .env || echo "   !! ANTHROPIC_API_KEY not set in .env"

echo "== deps + build"
pnpm install --frozen-lockfile
pnpm build

echo "== postgres"
docker compose up -d
for i in $(seq 1 30); do docker compose exec -T postgres pg_isready -U bazaar >/dev/null 2>&1 && break; sleep 1; done
pnpm db:migrate
pnpm db:seed || true   # prints member tokens on first run; no-op afterwards
if ! grep -q '^BAZAAR_HOUSEHOLD_ID=hh_' .env; then
  HH=$(docker compose exec -T postgres psql -U bazaar -d bazaar -tAc "select id from households order by created_at limit 1" | tr -d '[:space:]')
  [ -n "$HH" ] && sed -i "s|^BAZAAR_HOUSEHOLD_ID=.*|BAZAAR_HOUSEHOLD_ID=$HH|" .env && echo "   BAZAAR_HOUSEHOLD_ID=$HH"
fi

echo "== pm2"
pm2 startOrReload deploy/ecosystem.config.cjs --update-env
pm2 save

echo "== health"
sleep 2
curl -fsS http://127.0.0.1:8787/health && echo
echo
echo "Next: pnpm auth:instamart   (needs: ssh -L 8765:127.0.0.1:8765 <user>@<vps> from a laptop, then open the printed URL)"
echo "Optional Caddy: add to /etc/caddy/Caddyfile ->  bazaar.sciscribesolutions.com { reverse_proxy 127.0.0.1:8787 }  then: sudo systemctl reload caddy"
