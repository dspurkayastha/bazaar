import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api';

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('api error shape matches the server (docs/WEB_API.md)', () => {
  it('wrong PIN: attemptsLeft sits beside error and reaches extra', async () => {
    respond(403, { error: { code: 'pin_incorrect', message: 'Wrong PIN.' }, attemptsLeft: 2 });
    const e = (await api('POST', '/api/carts/h/approve', { pin: '0000' }).catch((x) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('pin_incorrect');
    expect(e.extra.attemptsLeft).toBe(2);
  });

  it('locked: pinLocked, hardLocked and lockedUntil reach extra', async () => {
    respond(423, {
      error: { code: 'pin_locked' },
      pinLocked: true,
      hardLocked: false,
      lockedUntil: '2026-10-13T10:15:00Z',
    });
    const e = (await api('POST', '/api/carts/h/approve', { pin: '0000' }).catch((x) => x)) as ApiError;
    expect(e.status).toBe(423);
    expect(e.extra).toMatchObject({ pinLocked: true, hardLocked: false, lockedUntil: '2026-10-13T10:15:00Z' });
  });
});
