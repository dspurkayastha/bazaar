// pnpm web:build — build the web app (web/) into web/dist, which Bazaar serves at /. No-op without web/package.json.
// Installs web/'s dependencies first (frozen lockfile), then builds.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('web/package.json')) {
  console.log('web/package.json not found: nothing to build (the web app is not in this checkout yet).');
  process.exit(0);
}
const run = (args: string[]) => {
  const r = spawnSync('pnpm', args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
// Always install: it is a fast no-op when up to date, and picks up dependencies added since the last deploy.
run(['--dir', 'web', 'install', ...(existsSync('web/pnpm-lock.yaml') ? ['--frozen-lockfile'] : [])]);
run(['--dir', 'web', 'build']);
