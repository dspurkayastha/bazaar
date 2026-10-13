#!/usr/bin/env bash
# One-shot VPS setup for Bazaar on the SciScribe Hetzner box (Ubuntu 24.04, Docker + PM2 already present).
# Bazaar listens on 127.0.0.1:8787 only; the public door is a Cloudflare Tunnel + Worker (deploy/cloudflare.md).
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
  npm i -g pnpm
  # Deliberately NOT running `pm2 update`: it respawns the daemon and other apps on this box
  # (apollo-web, sciscribe-web) did not come back on 12 Oct 2026. They keep running on the old
  # runtime until their next restart, which is fine.
fi
command -v ffmpeg >/dev/null || apt-get install -y ffmpeg   # voice:test converts recordings
command -v pnpm >/dev/null || npm i -g pnpm
command -v pm2 >/dev/null || npm i -g pm2
node -v

echo "== .env"
gen() { node -e "console.log(require('crypto').randomBytes($1).toString('base64url'))"; }
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|^BAZAAR_API_TOKEN=.*|BAZAAR_API_TOKEN=$(gen 32)|" .env
  sed -i "s|^TOKEN_ENC_KEY=.*|TOKEN_ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")|" .env
  sed -i "s|^WHATSAPP_WEBHOOK_SECRET=.*|WHATSAPP_WEBHOOK_SECRET=$(gen 32)|" .env
  sed -i "s|^BAZAAR_SUPPLIERS=.*|BAZAAR_SUPPLIERS=instamart|" .env
  echo "   wrote .env with fresh secrets. ANTHROPIC_API_KEY still needs to be set."
fi
# Postgres host port: keep an existing choice, otherwise take the first free port from 5433
if ! grep -q '^BAZAAR_PG_PORT=' .env; then
  PG_PORT=""
  for p in $(seq 5433 5460); do
    if ! ss -ltnH "sport = :$p" | grep -q .; then PG_PORT=$p; break; fi
  done
  [ -n "$PG_PORT" ] || { echo "no free port in 5433-5460"; exit 1; }
  echo "BAZAAR_PG_PORT=$PG_PORT" >> .env
  echo "   Postgres will listen on 127.0.0.1:$PG_PORT"
fi
# Web app origin + passkey RP id (added to an older .env that predates the web app)
grep -q '^WEB_ORIGIN=' .env || echo 'WEB_ORIGIN=https://bazaar.sciscribesolutions.com' >> .env
grep -q '^WEBAUTHN_RP_ID=' .env || echo 'WEBAUTHN_RP_ID=bazaar.sciscribesolutions.com' >> .env
grep -q '^PIN_REQUIRED_ABOVE_RUPEES=' .env || echo 'PIN_REQUIRED_ABOVE_RUPEES=500' >> .env
# Shared secret with the Cloudflare Worker: every request but /health must carry it (X-Bazaar-Edge). Never rotated here.
if ! grep -q '^EDGE_SECRET=.' .env; then
  NEW_EDGE_SECRET=$(gen 32)
  sed -i '/^EDGE_SECRET=/d' .env
  echo "EDGE_SECRET=$NEW_EDGE_SECRET" >> .env
  echo "   generated EDGE_SECRET. It is shown ONCE, here:"
  echo
  echo "       $NEW_EDGE_SECRET"
  echo
  echo "   Paste it into Cloudflare: Workers & Pages -> bazaar -> Settings -> Variables and Secrets -> Add -> Secret, name EDGE_SECRET."
  echo "   (Lost it? Read it from /opt/bazaar/.env.) Until both sides match, the site answers 403."
fi
PG_PORT=$(grep '^BAZAAR_PG_PORT=' .env | cut -d= -f2)
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgres://bazaar:bazaar@127.0.0.1:$PG_PORT/bazaar|" .env
grep -q '^ANTHROPIC_API_KEY=sk-' .env || echo "   !! ANTHROPIC_API_KEY not set in .env"

echo "== deps + build"
pnpm install --frozen-lockfile
pnpm build
pnpm web:build   # web/ → web/dist (served at /); a no-op until the web app is in the checkout

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
if ! grep -q '^ANTHROPIC_API_KEY=sk-' .env; then
  echo "   ANTHROPIC_API_KEY is empty: not starting bazaar (it would crash-loop)."
  echo "   Set it in /opt/bazaar/.env, then: pm2 start deploy/ecosystem.config.cjs && pm2 save"
  exit 0
fi
count_apps() { pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).length)}catch{console.log(0)}})'; }
BEFORE=$(count_apps)
pm2 startOrReload deploy/ecosystem.config.cjs --update-env
AFTER=$(count_apps)
# Only persist the process list if nothing that was running before has disappeared.
if [ "$AFTER" -ge "$BEFORE" ] && [ "$AFTER" -ge 1 ]; then
  pm2 save
else
  echo "   !! PM2 had $BEFORE apps before and $AFTER after; NOT saving the process list. Check 'pm2 ls'."
fi

echo "== health"
for i in $(seq 1 15); do curl -fsS http://127.0.0.1:8787/health && echo && break; sleep 1; done
echo
echo "Next: pnpm auth:instamart   (needs: ssh -L 8765:127.0.0.1:8765 <user>@<vps> from a laptop, then open the printed URL)"
echo "Web sign-in: pnpm member:setup-link dev   (prints a one-time link; open it on the iPhone, register Face ID, set the PIN)"
echo "Public access: Cloudflare Tunnel (cloudflared) -> http://127.0.0.1:8787 and the bazaar Worker. No Caddy block is needed. Steps: deploy/cloudflare.md"
