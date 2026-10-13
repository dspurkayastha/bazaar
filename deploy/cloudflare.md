# Putting Bazaar on Cloudflare

What you end up with, all on one origin, `https://bazaar.sciscribesolutions.com`:

```
browser ──► Cloudflare Worker "bazaar"  ──/api/* and /voice──►  bazaar-origin.sciscribesolutions.com
            (serves the app from static           (adds X-Bazaar-Edge)        │  Cloudflare Tunnel (cloudflared on the VPS)
             assets, same origin)                                              ▼
                                                                       http://127.0.0.1:8787  (Bazaar, pm2)
```

- The VPS exposes nothing: Bazaar listens on `127.0.0.1:8787`, and `cloudflared` dials out to Cloudflare. No open port, no Caddy.
- Anyone who finds `bazaar-origin.sciscribesolutions.com` gets `403`: Bazaar answers only requests that carry the shared secret `EDGE_SECRET` in `X-Bazaar-Edge` (except `/health`), and only the Worker has it.
- Branch previews (`*.workers.dev`) show the app on sample data with no sign-in and no API calls. The Worker answers `/api` and `/voice` with 404 there.

The site is down from step 1 until step 5 passes. Do it in one sitting. You need: the Cloudflare account that owns `sciscribesolutions.com`, SSH to the VPS, and the GitHub repo `dspurkayastha/bazaar` pushed with this branch merged.

## 1. Clear the old route (DNS and Caddy)

**DNS (dashboard).** Cloudflare dashboard → the `sciscribesolutions.com` zone → DNS → Records. Delete the `bazaar` record if there is one (an `A` record to `37.27.211.131`). If it stays, step 3 cannot attach the custom domain. Leave every other record alone.

**Caddy (VPS).** If `/etc/caddy/Caddyfile` has a block for `bazaar.sciscribesolutions.com`, remove it and reload:

```sh
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak && sudo sed -i '/^bazaar\.sciscribesolutions\.com *{/,/^}/d' /etc/caddy/Caddyfile && sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

That deletes from the line that starts the block to the first `}` at the start of a line, so it is right for the usual one-line `reverse_proxy` block. Check `grep -n bazaar /etc/caddy/Caddyfile` prints nothing. The other sites on the box are untouched; if `validate` complains, restore with `sudo cp /etc/caddy/Caddyfile.bak /etc/caddy/Caddyfile`.

## 2. The tunnel

1. Dashboard → Zero Trust → Networks → Tunnels (Cloudflare's current docs call this Networking → Tunnels) → **Create a tunnel** → type **Cloudflared** → name it `bazaar` → Save.
2. Pick **Debian** (64-bit). The page shows an install command ending in `sudo cloudflared service install <token>`. Keep the page open; the token is in that command.
3. On the VPS, install the package first (the dashboard command needs `cloudflared` on the box), from Cloudflare's apt repository (https://pkg.cloudflare.com):

   ```sh
   sudo mkdir -p --mode=0755 /usr/share/keyrings
   curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
   echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
   sudo apt-get update && sudo apt-get install -y cloudflared
   ```

   (If the repository will not work, `curl -fsSLo /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && sudo dpkg -i /tmp/cloudflared.deb` does the same.)

4. Run the command the dashboard gave you: `sudo cloudflared service install <token>`. It installs and starts a systemd service. Check `systemctl status cloudflared` says active. The dashboard page flips to **Connected**; click Next.
5. Add the public hostname (the dashboard calls it a published application route): subdomain `bazaar-origin`, domain `sciscribesolutions.com`, no path. Service type **HTTP**, URL `127.0.0.1:8787` (as a single URL: `http://127.0.0.1:8787`). Save. Cloudflare creates the proxied `bazaar-origin` DNS record for you.

## 3. The Worker (static assets + forwarder)

1. Dashboard → Workers & Pages → **Create** → **Import a repository** (connect GitHub if asked) → `dspurkayastha/bazaar`.
2. Project name: **`bazaar`**. It must equal `name` in `web/wrangler.toml`. Production branch `main`.
3. Build settings:
   - Root directory: `web`
   - Build command: `pnpm install --frozen-lockfile && pnpm build`
   - Deploy command: `npx wrangler deploy`
   - Non-production branch deploy command: `npx wrangler versions upload`
   - Build variable (optional, belt and braces): `NODE_VERSION` = `22`

   Workers Builds uses the Wrangler pinned in `web/package.json` (4.148.0). Save and deploy. The first build runs now and should succeed.

4. Settings → **Variables and Secrets** → Add → type **Secret**, name `EDGE_SECRET`, value from step 4 below. (Generate it first if you like: step 4 gives the command. You can add the secret any time after the first deploy.) `PRODUCTION_HOST`, `ORIGIN_URL` and `WS_MODE` are plain variables already set by `wrangler.toml`; do not retype them in the dashboard.
5. Settings → **Domains & Routes** → Add → **Custom domain** → `bazaar.sciscribesolutions.com`. Cloudflare creates the DNS record and certificate. Leave Version URLs enabled (that is what gives branch previews their URLs).

Branch previews: every non-production branch push runs `wrangler versions upload`, and the Builds page shows a version URL like `<prefix>-bazaar.<your-subdomain>.workers.dev`. Open it: banner "Preview — sample data", every screen filled, buttons say "Preview only".

## 4. The VPS side

Generate the secret once, store it in the VPS `.env`, and print it once for pasting into Cloudflare (step 3.4):

```sh
cd /opt/bazaar && S=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") && { grep -q '^EDGE_SECRET=' .env && sed -i "s|^EDGE_SECRET=.*|EDGE_SECRET=$S|" .env || echo "EDGE_SECRET=$S" >> .env; } && echo "$S"
```

(`bash deploy/setup-vps.sh` does the same if `.env` has no `EDGE_SECRET`, and prints it the same way. It never replaces an existing one. To read it later: `grep ^EDGE_SECRET /opt/bazaar/.env`.)

Keep `WEB_ORIGIN=https://bazaar.sciscribesolutions.com` and `WEBAUTHN_RP_ID=bazaar.sciscribesolutions.com` in the same file (setup-vps.sh adds them if missing). Pull this branch's code, rebuild and restart so the server knows about the secret:

```sh
cd /opt/bazaar && git pull && pnpm install --frozen-lockfile && pnpm build && pm2 restart bazaar --update-env
```

Do not leave `EDGE_SECRET` out of the Cloudflare side: with it set on the VPS and missing on the Worker, every request is a 403.

## 5. Check it

From any machine:

```sh
curl -i https://bazaar-origin.sciscribesolutions.com/api/me     # 403 {"error":{"code":"forbidden"...}}: the origin refuses anything without the secret
curl -i https://bazaar.sciscribesolutions.com/api/me            # 401: the Worker reached Bazaar, you are just not signed in
curl -sI https://bazaar.sciscribesolutions.com/ | grep -i -E 'content-security|cache-control'
curl -i --max-time 5 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: https://bazaar.sciscribesolutions.com' https://bazaar.sciscribesolutions.com/voice
```

- The first must be 403. (`/health` on the origin is deliberately open and answers 200; it holds no data.)
- The second must be 401. A 403 means the two `EDGE_SECRET`s differ; a 502 means the tunnel is down (`systemctl status cloudflared`, `pm2 ls`).
- The third shows the CSP (`default-src 'self' …`) and `no-cache` on the page.
- The fourth must print `HTTP/1.1 101 Switching Protocols`. That is the WebSocket passing through the Worker (the server then closes it with code 4401 because there is no sign-in; curl just stops). If it prints 101, voice will work.

Then open https://bazaar.sciscribesolutions.com in a browser: you should see the sign-in screen. Make the passkey link on the VPS and open it on the iPhone in Safari:

```sh
cd /opt/bazaar && pnpm member:setup-link dev
```

It prints `https://bazaar.sciscribesolutions.com/setup/<code>` (single use, 48 hours). Create the passkey with Face ID, set the PIN under Home → Security, then tap Talk: the orb should reach "Listening".

### If voice does not connect

If the `101` check fails, or Talk says "The voice connection dropped" right away while `/api` works, the Worker is not handing the upgrade through as is. In `web/wrangler.toml` change `WS_MODE = "passthrough"` to `WS_MODE = "splice"`, commit to `main`, let Workers Builds deploy, and re-run the fourth check. In that mode the Worker opens the socket to the VPS itself and copies messages and close codes (4401, 4409, 1011) both ways.

## Day to day

- Deploy the app: merge to `main`. Workers Builds rebuilds and deploys. Bazaar server changes still go by `git pull && pnpm build && pm2 restart bazaar` on the VPS.
- Rotate the secret: run the step 4 one-liner (it replaces the old value), `pm2 restart bazaar --update-env`, and update `EDGE_SECRET` in Cloudflare (Settings → Variables and Secrets → Edit). The few seconds in between answer 403.
- Never log or paste the secret into the repo. It lives only in `/opt/bazaar/.env` and the Worker's secret store.
