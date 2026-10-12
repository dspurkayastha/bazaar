/**
 * Web sign-in (docs/WEB_API.md "Identity", "PIN"):
 *
 *   GET  /api/me                       session → who am I, PIN state
 *   POST /api/setup/:code/options      one-time setup link → passkey registration options (+ member name)
 *   POST /api/setup/:code/verify       registration → passkey stored, setup code used, session cookie
 *   POST /api/login/options            → discoverable-credential assertion options (also used before POST /api/pin)
 *   POST /api/login/verify             assertion → session cookie
 *   POST /api/logout                   session revoked, cookie cleared
 *   POST /api/pin                      owner session + fresh passkey assertion (same request) → PIN set / reset
 *
 * Every non-GET needs `X-Bazaar: 1` (auth.ts). Errors are `{error:{code, message}}`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isValidPin } from '../../auth/pin.js';
import { clearedSessionCookie, findUsableSetupCode, sessionCookie } from '../../auth/session.js';
import { PasskeyAuth, PasskeyError } from '../../auth/webauthn.js';
import { newId } from '../../core/ids.js';
import type { Household, Member } from '../../core/types.js';
import { memberOf, sessionsOf } from '../auth.js';
import { ApiError, body, pinsOf, webOf, type ApiDeps } from '../http.js';

const nowOf = (deps: ApiDeps) => deps.now?.() ?? new Date().toISOString();

/** PasskeyError → ApiError with the same status and code. */
async function passkey<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PasskeyError) throw new ApiError(e.status, e.message, e.code);
    throw e;
  }
}

/** The member and household behind a session/token, or 401 (the member was removed). */
export async function whoIs(deps: ApiDeps, req: FastifyRequest): Promise<{ household: Household; member: Member }> {
  const who = memberOf(req);
  const household = await deps.store.loadHousehold(who.householdId);
  const member = household.members.find((m) => m.id === who.memberId);
  if (!member) throw new ApiError(401, 'Sign in again.', 'unauthorised');
  return { household, member };
}

export function requireOwner(member: Member): void {
  if (member.role !== 'owner') throw new ApiError(403, 'Only an owner can do that.', 'owner_required');
}

async function startSession(deps: ApiDeps, reply: FastifyReply, member: Member): Promise<void> {
  const { token } = await sessionsOf(deps).create(member);
  reply.header('set-cookie', sessionCookie(token));
}

export function registerWebAuthRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const web = webOf(deps);
  const passkeys = new PasskeyAuth(deps.store, web, () => nowOf(deps));

  app.get('/api/me', { config: { auth: 'session' } }, async (req) => {
    const { household, member } = await whoIs(deps, req);
    const pin = await pinsOf(deps).status(member.id);
    return {
      member: { id: member.id, name: member.name, role: member.role },
      household: { id: household.id, name: household.name },
      pinSet: pin.pinSet,
      pinLocked: pin.pinLocked,
      ...(pin.lockedUntil ? { pinLockedUntil: pin.lockedUntil } : {}),
    };
  });

  const setupFor = async (code: string) => {
    const rec = await findUsableSetupCode(deps.store, code, nowOf(deps));
    if (!rec)
      throw new ApiError(404, 'This setup link is invalid, used or expired. Ask for a new one.', 'setup_invalid');
    const household = await deps.store.loadHousehold(rec.householdId);
    const member = household.members.find((m) => m.id === rec.memberId);
    if (!member) throw new ApiError(404, 'This setup link is invalid, used or expired.', 'setup_invalid');
    return { rec, member };
  };

  app.post<{ Params: { code: string } }>('/api/setup/:code/options', { config: { auth: 'none' } }, async (req) => {
    const { rec, member } = await setupFor(req.params.code);
    const options = await passkeys.registrationOptions(member, rec.id);
    return { ...options, member: { name: member.name } };
  });

  app.post<{ Params: { code: string } }>(
    '/api/setup/:code/verify',
    { config: { auth: 'none' } },
    async (req, reply) => {
      const { rec, member } = await setupFor(req.params.code);
      const pk = await passkey(passkeys.verifyRegistration(member, rec.id, req.body));
      // Single use: only the request that consumes the code stores its passkey.
      if (!(await deps.store.consumeSetupCode(rec.id, nowOf(deps))))
        throw new ApiError(409, 'This setup link was already used.', 'setup_used');
      await deps.store.savePasskey(pk);
      await deps.store.recordSecurityEvent({
        id: newId('sev'),
        householdId: member.householdId,
        memberId: member.id,
        kind: 'passkey_registered',
        at: nowOf(deps),
        detail: { credential: pk.id.slice(0, 8) },
      });
      await startSession(deps, reply, member);
      return { ok: true };
    },
  );

  app.post('/api/login/options', { config: { auth: 'none' } }, async () => passkeys.authenticationOptions());

  app.post('/api/login/verify', { config: { auth: 'none' } }, async (req, reply) => {
    const { memberId } = await passkey(passkeys.verifyAuthentication(req.body));
    const member = await memberById(deps, memberId);
    if (!member) throw new ApiError(401, 'This passkey is not registered.', 'unknown_passkey');
    await startSession(deps, reply, member);
    return { ok: true };
  });

  app.post('/api/logout', { config: { auth: 'session' } }, async (req, reply) => {
    if (req.webSession) await sessionsOf(deps).revoke(req.webSession.id);
    reply.header('set-cookie', clearedSessionCookie());
    return { ok: true };
  });

  app.post('/api/pin', { config: { auth: 'session' } }, async (req) => {
    const { member } = await whoIs(deps, req);
    requireOwner(member);
    const o = body(req.body);
    if (!isValidPin(o.pin)) throw new ApiError(400, 'The PIN is 4 to 6 digits.', 'pin_invalid');
    if (o.assertion === undefined)
      throw new ApiError(400, 'Confirm with Face ID (passkey) to set the PIN.', 'assertion_required');
    const signer = await passkey(passkeys.verifyAuthentication(o.assertion));
    if (signer.memberId !== member.id)
      throw new ApiError(403, "That passkey is not this member's.", 'assertion_mismatch');
    await pinsOf(deps).setPin(member, o.pin);
    return { ok: true };
  });
}

/** The passkey's member. Sign-in knows only the member id; v1 runs one household per deployment. */
async function memberById(deps: ApiDeps, memberId: string): Promise<Member | undefined> {
  const household = await deps.store.loadHousehold(deps.defaultHouseholdId);
  return household.members.find((m) => m.id === memberId);
}
