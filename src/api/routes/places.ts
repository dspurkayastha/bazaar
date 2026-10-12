/**
 * GET/POST/PATCH /places.
 *
 * POST takes the supplier-side address ids the client got from the supplier's saved addresses (the Supplier
 * interface has no address listing). Making a place `trusted` lifts the unattended-pay limit for it, so setting
 * `trusted: true` (POST or PATCH) requires the caller's own token to be an owner's. New places are untrusted by
 * default. All three act on the caller's household (from the token); body `memberId` / `householdId` are ignored.
 */
import type { FastifyInstance } from 'fastify';
import { uniqueKey } from '../../core/identity.js';
import { newId } from '../../core/ids.js';
import type { Household, Place, SupplierId } from '../../core/types.js';
import { memberOf, type AuthedMember } from '../auth.js';
import { ApiError, body, optBool, optNumber, optString, optStringArray, reqString, type ApiDeps } from '../http.js';

const SUPPLIER_IDS: SupplierId[] = ['instamart', 'swiggy_food', 'zomato', 'blinkit', 'zepto', 'kirana'];

function parseAddressIds(raw: unknown): Place['supplierAddressIds'] {
  const o = body(raw);
  const out: Place['supplierAddressIds'] = {};
  for (const [k, v] of Object.entries(o)) {
    if (!(SUPPLIER_IDS as string[]).includes(k)) throw new ApiError(400, `unknown supplier ${k}`);
    if (typeof v !== 'string' || v === '') throw new ApiError(400, `supplierAddressIds.${k} must be a string`);
    out[k as SupplierId] = v;
  }
  if (Object.keys(out).length === 0) throw new ApiError(400, 'supplierAddressIds needs at least one supplier address');
  return out;
}

function requireOwner(household: Household, who: AuthedMember): void {
  const m = household.members.find((x) => x.id === who.memberId);
  if (!m || m.role !== 'owner') throw new ApiError(403, "trusting a place requires an owner's token");
}

function assertNicknameFree(household: Household, nickname: string, exceptId?: string): void {
  const n = nickname.toLowerCase();
  if (household.places.some((p) => p.id !== exceptId && p.nickname.toLowerCase() === n)) {
    throw new ApiError(409, `a place called ${nickname} already exists`);
  }
}

export function registerPlaceRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/places', { config: { auth: 'member' } }, async (req) => {
    const household = await deps.store.loadHousehold(memberOf(req).householdId);
    return { places: household.places };
  });

  app.post('/places', { config: { auth: 'member' } }, async (req, reply) => {
    const o = body(req.body);
    const who = memberOf(req);
    const household = await deps.store.loadHousehold(who.householdId);
    const nickname = reqString(o, 'nickname', 60);
    assertNicknameFree(household, nickname);
    const trusted = optBool(o, 'trusted') ?? false;
    if (trusted) requireOwner(household, who);
    const lat = optNumber(o, 'lat');
    const lng = optNumber(o, 'lng');
    const place: Place = {
      id: newId('pl'),
      householdId: household.id,
      key: uniqueKey(nickname, household.places.map((p) => p.key)),
      nickname,
      aliases: optStringArray(o, 'aliases') ?? [],
      canonicalAddress: reqString(o, 'canonicalAddress', 500),
      city: reqString(o, 'city', 100),
      ...(lat !== undefined ? { lat } : {}),
      ...(lng !== undefined ? { lng } : {}),
      supplierAddressIds: parseAddressIds(o.supplierAddressIds),
      serviceability: [],
      trusted,
      isDefault: (optBool(o, 'isDefault') ?? false) || household.places.length === 0,
    };
    await deps.store.savePlace(place);
    return reply.code(201).send({ place });
  });

  app.patch<{ Params: { id: string } }>('/places/:id', { config: { auth: 'member' } }, async (req) => {
    const o = body(req.body);
    const who = memberOf(req);
    const household = await deps.store.loadHousehold(who.householdId);
    const existing = household.places.find((p) => p.id === req.params.id);
    if (!existing) throw new ApiError(404, 'no such place');
    const next: Place = { ...existing };
    const nickname = optString(o, 'nickname', 60);
    if (nickname !== undefined) {
      assertNicknameFree(household, nickname, existing.id);
      next.nickname = nickname;
    }
    const aliases = optStringArray(o, 'aliases');
    if (aliases !== undefined) next.aliases = aliases;
    const trusted = optBool(o, 'trusted');
    if (trusted !== undefined && trusted !== existing.trusted) {
      // Only raising trust needs an owner; revoking it is always allowed.
      if (trusted) requireOwner(household, who);
      next.trusted = trusted;
    }
    const isDefault = optBool(o, 'isDefault');
    if (isDefault === true) next.isDefault = true;
    if (isDefault === false && existing.isDefault) throw new ApiError(400, 'set another place as default instead');
    await deps.store.savePlace(next);
    return { place: next };
  });
}
