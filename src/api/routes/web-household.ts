/**
 * Household management from the web app (docs/WEB_API.md "Routes"). Reads for every signed-in member; changes for
 * owners only.
 *
 *   GET   /api/household                              members (phones, hasPasskey) and places
 *   POST  /api/household/members                      {name, role, phones[], defaultPlaceId?} → member
 *   PATCH /api/household/members/:id                  partial → member
 *   POST  /api/household/members/:id/setup-link       → {url, expiresAt} (shown once; replaces older links)
 *   POST  /api/household/places                       {nickname, aliases[], city, instamartAddressId?, trusted?, isDefault?}
 *   PATCH /api/household/places/:id                   partial → place
 *   GET   /api/household/supplier-addresses           Instamart saved addresses not yet mapped to a place
 *
 * Phones are E.164 and unique across the household (409 phone_taken). A household always keeps at least one owner.
 */
import type { FastifyInstance } from 'fastify';
import { createSetupLink } from '../../auth/session.js';
import { BazaarError } from '../../core/errors.js';
import { isE164, normalisePhone, uniqueKey } from '../../core/identity.js';
import { newId } from '../../core/ids.js';
import type { Household, Member, MemberRole, Place } from '../../core/types.js';
import { hasAddressBook, type SupplierAddress } from '../../suppliers/instamart/adapter.js';
import { ApiError, body, optBool, optString, optStringArray, reqString, webOf, type ApiDeps } from '../http.js';
import { requireOwner, whoIs } from './web-auth.js';

const ROLES: MemberRole[] = ['owner', 'adder', 'viewer', 'dependant'];
const MAX_PHONES = 5;

type Json = Record<string, unknown>;

function memberView(m: Member, passkeyIds: Set<string>) {
  return {
    id: m.id,
    name: m.name,
    role: m.role,
    phones: m.phones,
    defaultPlaceId: m.defaultPlaceId ?? null,
    hasPasskey: passkeyIds.has(m.id),
  };
}

function placeView(p: Place) {
  return {
    id: p.id,
    key: p.key,
    nickname: p.nickname,
    aliases: p.aliases,
    city: p.city,
    trusted: p.trusted,
    isDefault: p.isDefault,
    supplierAddressIds: p.supplierAddressIds,
    serviceability: p.serviceability,
  };
}

function parseRole(o: Json): MemberRole | undefined {
  const r = optString(o, 'role', 20);
  if (r === undefined) return undefined;
  if (!(ROLES as string[]).includes(r)) throw new ApiError(400, `role must be one of ${ROLES.join(', ')}`, 'bad_role');
  return r as MemberRole;
}

/** phones[] → E.164, de-duplicated; any invalid number is a 400 naming it. */
function parsePhones(o: Json): string[] | undefined {
  const raw = o.phones;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string'))
    throw new ApiError(400, 'phones must be an array of strings', 'bad_phone');
  const out: string[] = [];
  for (const s of raw as string[]) {
    const p = normalisePhone(s);
    if (!p || !isE164(p))
      throw new ApiError(400, `${s.slice(0, 20)} is not a phone number in +country format`, 'bad_phone');
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > MAX_PHONES) throw new ApiError(400, `at most ${MAX_PHONES} phones per member`, 'bad_phone');
  return out;
}

function assertPhonesFree(household: Household, phones: string[], exceptId?: string): void {
  for (const m of household.members) {
    if (m.id === exceptId) continue;
    const clash = phones.find((p) => m.phones.includes(p));
    if (clash) throw new ApiError(409, `${clash} already belongs to ${m.name}`, 'phone_taken');
  }
}

function parseDefaultPlace(household: Household, o: Json): string | null | undefined {
  if (!('defaultPlaceId' in o)) return undefined;
  if (o.defaultPlaceId === null) return null;
  const id = optString(o, 'defaultPlaceId', 64);
  if (id === undefined) return undefined;
  if (!household.places.some((p) => p.id === id)) throw new ApiError(400, 'no such place', 'bad_place');
  return id;
}

async function saveMember(deps: ApiDeps, m: Member): Promise<void> {
  try {
    await deps.store.saveMember(m);
  } catch (e) {
    if (e instanceof BazaarError && e.code === 'PHONE_TAKEN')
      throw new ApiError(409, 'A phone number already belongs to another member.', 'phone_taken');
    throw e;
  }
}

function assertNicknameFree(household: Household, nickname: string, exceptId?: string): void {
  const n = nickname.toLowerCase();
  if (household.places.some((p) => p.id !== exceptId && p.nickname.toLowerCase() === n))
    throw new ApiError(409, `a place called ${nickname} already exists`, 'nickname_taken');
}

export function registerWebHouseholdRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const nowOf = () => deps.now?.() ?? new Date().toISOString();
  const instamart = () => deps.suppliers.find((s) => s.id === 'instamart' && hasAddressBook(s));
  const savedAddresses = async (): Promise<SupplierAddress[] | undefined> => {
    const s = instamart();
    return s && hasAddressBook(s) ? s.getAddresses() : undefined;
  };

  app.get('/api/household', { config: { auth: 'session' } }, async (req) => {
    const { household } = await whoIs(deps, req);
    const withPasskeys = new Set(await deps.store.passkeyMemberIds(household.id));
    return {
      members: household.members.map((m) => memberView(m, withPasskeys)),
      places: household.places.map(placeView),
    };
  });

  app.post('/api/household/members', { config: { auth: 'session' } }, async (req, reply) => {
    const { household, member: me } = await whoIs(deps, req);
    requireOwner(me);
    const o = body(req.body);
    const phones = parsePhones(o) ?? [];
    assertPhonesFree(household, phones);
    const defaultPlaceId = parseDefaultPlace(household, o);
    const m: Member = {
      id: newId('mem'),
      householdId: household.id,
      name: reqString(o, 'name', 60),
      role: parseRole(o) ?? 'adder',
      channels: [],
      phones,
      ...(defaultPlaceId ? { defaultPlaceId } : {}),
    };
    await saveMember(deps, m);
    return reply.code(201).send(memberView(m, new Set()));
  });

  app.patch<{ Params: { id: string } }>('/api/household/members/:id', { config: { auth: 'session' } }, async (req) => {
    const { household, member: me } = await whoIs(deps, req);
    requireOwner(me);
    const existing = household.members.find((m) => m.id === req.params.id);
    if (!existing) throw new ApiError(404, 'no such member', 'not_found');
    const o = body(req.body);
    const next: Member = structuredClone(existing);
    const name = optString(o, 'name', 60);
    if (name !== undefined) next.name = name;
    const role = parseRole(o);
    if (role !== undefined && role !== existing.role) {
      const owners = household.members.filter((m) => m.role === 'owner');
      if (existing.role === 'owner' && owners.length === 1)
        throw new ApiError(409, 'The household needs at least one owner.', 'last_owner');
      next.role = role;
    }
    const phones = parsePhones(o);
    if (phones !== undefined) {
      assertPhonesFree(household, phones, existing.id);
      next.phones = phones;
    }
    const dp = parseDefaultPlace(household, o);
    if (dp === null) delete next.defaultPlaceId;
    else if (dp !== undefined) next.defaultPlaceId = dp;
    await saveMember(deps, next);
    const withPasskeys = new Set(await deps.store.passkeyMemberIds(household.id));
    return memberView(next, withPasskeys);
  });

  app.post<{ Params: { id: string } }>(
    '/api/household/members/:id/setup-link',
    { config: { auth: 'session' } },
    async (req) => {
      const { household, member: me } = await whoIs(deps, req);
      requireOwner(me);
      const target = household.members.find((m) => m.id === req.params.id);
      if (!target) throw new ApiError(404, 'no such member', 'not_found');
      return createSetupLink(deps.store, {
        memberId: target.id,
        householdId: household.id,
        createdBy: me.id,
        origin: webOf(deps).origin,
        now: nowOf(),
      });
    },
  );

  app.post('/api/household/places', { config: { auth: 'session' } }, async (req, reply) => {
    const { household, member: me } = await whoIs(deps, req);
    requireOwner(me);
    const o = body(req.body);
    const nickname = reqString(o, 'nickname', 60);
    assertNicknameFree(household, nickname);
    const city = reqString(o, 'city', 100);
    const instamartAddressId = optString(o, 'instamartAddressId', 200);
    let canonicalAddress = `${nickname}, ${city}`;
    if (instamartAddressId !== undefined) {
      if (household.places.some((p) => p.supplierAddressIds.instamart === instamartAddressId))
        throw new ApiError(409, 'That Instamart address is already a place.', 'address_taken');
      const saved = await savedAddresses();
      const hit = saved?.find((a) => a.id === instamartAddressId);
      if (saved && !hit)
        throw new ApiError(400, 'That Instamart address is not in the saved addresses.', 'bad_address');
      if (hit?.addressLine) canonicalAddress = hit.addressLine;
    }
    const place: Place = {
      id: newId('pl'),
      householdId: household.id,
      key: uniqueKey(
        nickname,
        household.places.map((p) => p.key),
      ),
      nickname,
      aliases: optStringArray(o, 'aliases') ?? [],
      canonicalAddress,
      city,
      supplierAddressIds: instamartAddressId !== undefined ? { instamart: instamartAddressId } : {},
      serviceability: [],
      trusted: optBool(o, 'trusted') ?? false,
      isDefault: (optBool(o, 'isDefault') ?? false) || household.places.length === 0,
    };
    await deps.store.savePlace(place);
    return reply.code(201).send(placeView(place));
  });

  app.patch<{ Params: { id: string } }>('/api/household/places/:id', { config: { auth: 'session' } }, async (req) => {
    const { household, member: me } = await whoIs(deps, req);
    requireOwner(me);
    const existing = household.places.find((p) => p.id === req.params.id);
    if (!existing) throw new ApiError(404, 'no such place', 'not_found');
    const o = body(req.body);
    const next: Place = structuredClone(existing);
    const nickname = optString(o, 'nickname', 60);
    if (nickname !== undefined) {
      assertNicknameFree(household, nickname, existing.id);
      next.nickname = nickname;
    }
    const aliases = optStringArray(o, 'aliases');
    if (aliases !== undefined) next.aliases = aliases;
    const city = optString(o, 'city', 100);
    if (city !== undefined) next.city = city;
    const trusted = optBool(o, 'trusted');
    if (trusted !== undefined) next.trusted = trusted;
    const isDefault = optBool(o, 'isDefault');
    if (isDefault === true) next.isDefault = true;
    if (isDefault === false && existing.isDefault)
      throw new ApiError(400, 'Set another place as default instead.', 'default_required');
    if ('instamartAddressId' in o) {
      const id = o.instamartAddressId === null ? undefined : optString(o, 'instamartAddressId', 200);
      if (
        id !== undefined &&
        household.places.some((p) => p.id !== existing.id && p.supplierAddressIds.instamart === id)
      )
        throw new ApiError(409, 'That Instamart address is already a place.', 'address_taken');
      if (id === undefined) delete next.supplierAddressIds.instamart;
      else next.supplierAddressIds.instamart = id;
      next.serviceability = next.serviceability.filter((s) => s.supplierId !== 'instamart');
    }
    await deps.store.savePlace(next);
    return placeView(next);
  });

  app.get('/api/household/supplier-addresses', { config: { auth: 'session' } }, async (req) => {
    const { household, member: me } = await whoIs(deps, req);
    requireOwner(me);
    const saved = await savedAddresses();
    if (!saved) return { addresses: [], available: false };
    const mapped = new Set(household.places.map((p) => p.supplierAddressIds.instamart).filter(Boolean));
    return { addresses: saved.filter((a) => !mapped.has(a.id)), available: true };
  });
}
