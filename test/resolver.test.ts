import { describe, expect, it } from 'vitest';
import type { Household, Member, Place, ShopRequest } from '../src/core/types.js';
import { resolvePlace } from '../src/places/resolver.js';
import { getServiceable } from '../src/places/serviceability.js';
import { StubSupplier } from '../src/suppliers/stub/index.js';
import { NOW, household, placeNamed } from './fixtures/context.js';

function setup() {
  const h: Household = household();
  const rahuls = placeNamed(h, "rahul's");
  const hospital = placeNamed(h, 'hospital');
  hospital.lat = 24.8333;
  hospital.lng = 92.7789;
  const ma: Member = {
    id: 'mem_ma',
    householdId: h.id,
    name: 'Ma',
    role: 'dependant',
    channels: [],
    phones: [],
    defaultPlaceId: rahuls.id,
  };
  h.members.push(ma);
  return { h, ma, home: placeNamed(h, 'home'), hospital, rahuls, didis: placeNamed(h, "didi's") };
}

function req(h: Household, member: Member, text: string, context?: ShopRequest['context']): ShopRequest {
  return {
    id: 'req_1',
    householdId: h.id,
    memberId: member.id,
    channel: 'whatsapp',
    text,
    receivedAt: NOW,
    ...(context ? { context } : {}),
  };
}

describe('resolvePlace', () => {
  it('explicit nickname wins', () => {
    const { h, hospital } = setup();
    const dev = h.members[0]!;
    expect(resolvePlace(req(h, dev, 'send milk to the hospital'), h, dev)).toEqual({
      placeId: hospital.id,
      reason: 'explicit',
    });
  });

  it('explicit alias, including possessive and multi-word aliases', () => {
    const { h, hospital, didis } = setup();
    const dev = h.members[0]!;
    expect(resolvePlace(req(h, dev, 'curd to SCC please'), h, dev).placeId).toBe(hospital.id);
    expect(resolvePlace(req(h, dev, 'order dettol for the cancer centre'), h, dev).placeId).toBe(hospital.id);
    expect(resolvePlace(req(h, dev, "deliver to Didi's"), h, dev)).toMatchObject({
      placeId: didis.id,
      reason: 'explicit',
    });
  });

  it('tolerates a one-letter typo in a longer name', () => {
    const { h, hospital } = setup();
    const dev = h.members[0]!;
    expect(resolvePlace(req(h, dev, 'milk to the hospitl'), h, dev).placeId).toBe(hospital.id);
  });

  it('a nickname beats an alias of another place', () => {
    const { h, didis } = setup();
    const dev = h.members[0]!;
    // "house" is an alias of home; "didis" is didi's nickname.
    expect(resolvePlace(req(h, dev, "didi's house"), h, dev).placeId).toBe(didis.id);
  });

  it('two places naming the same score → a question, not a guess', () => {
    const { h, home, hospital } = setup();
    const dev = h.members[0]!;
    const r = resolvePlace(req(h, dev, 'milk for home or hospital'), h, dev);
    expect(r.question).toMatch(/home or hospital/);
    expect(r.candidates).toEqual(expect.arrayContaining([home.id, hospital.id]));
    expect(r.placeId).toBe(home.id); // household default as the fallback id
  });

  it('a dependant named in the text routes to their place', () => {
    const { h, rahuls } = setup();
    const dev = h.members[0]!;
    expect(resolvePlace(req(h, dev, 'send dettol for Ma'), h, dev)).toEqual({ placeId: rahuls.id, reason: 'member' });
  });

  it('a dependant requesting uses their own default place', () => {
    const { h, ma, rahuls } = setup();
    expect(resolvePlace(req(h, ma, 'need some milk'), h, ma)).toEqual({ placeId: rahuls.id, reason: 'member' });
  });

  it('explicit beats member', () => {
    const { h, ma, didis } = setup();
    expect(resolvePlace(req(h, ma, "milk to didi's"), h, ma)).toMatchObject({ placeId: didis.id, reason: 'explicit' });
  });

  it('calendar place, then geofence within 300 m', () => {
    const { h, hospital, didis } = setup();
    const dev = h.members[0]!;
    expect(resolvePlace(req(h, dev, 'milk', { calendarPlaceId: didis.id }), h, dev)).toEqual({
      placeId: didis.id,
      reason: 'context',
    });
    // ~110 m north of the hospital.
    expect(resolvePlace(req(h, dev, 'milk', { lat: 24.8343, lng: 92.7789 }), h, dev)).toEqual({
      placeId: hospital.id,
      reason: 'context',
    });
    // ~1.1 km away: outside the geofence → default.
    expect(resolvePlace(req(h, dev, 'milk', { lat: 24.8433, lng: 92.7789 }), h, dev).reason).toBe('default');
  });

  it('household default otherwise', () => {
    const { h, home } = setup();
    const dev = h.members[0]!;
    expect(resolvePlace(req(h, dev, 'two packs of milk'), h, dev)).toEqual({ placeId: home.id, reason: 'default' });
  });
});

describe('getServiceable', () => {
  const fresh = (p: Place, serviceable: boolean, ageH: number) => {
    p.serviceability = [
      {
        supplierId: 'instamart',
        serviceable,
        checkedAt: new Date(Date.parse(NOW) - ageH * 3_600_000).toISOString(),
      },
    ];
  };

  it('trusts a fresh cached yes without probing', async () => {
    const { home } = setup();
    fresh(home, true, 2);
    const s = new StubSupplier({ now: () => NOW });
    let probes = 0;
    const orig = s.checkServiceability.bind(s);
    s.checkServiceability = async (p) => (probes++, orig(p));
    const r = await getServiceable(home, [s], NOW);
    expect(r.suppliers).toEqual([s]);
    expect(probes).toBe(0);
    expect(r.probed).toEqual([]);
  });

  it('a fresh cached no is respected', async () => {
    const { home } = setup();
    fresh(home, false, 2);
    const s = new StubSupplier({ now: () => NOW });
    const r = await getServiceable(home, [s], NOW);
    expect(r.suppliers).toEqual([]);
    expect(r.probed).toEqual([]);
  });

  it('probes stale or missing records and returns them for persistence', async () => {
    const { home, hospital } = setup();
    fresh(home, false, 30); // stale "no" → re-probed → yes
    const s = new StubSupplier({ now: () => NOW });
    const r1 = await getServiceable(home, [s], NOW);
    expect(r1.suppliers).toEqual([s]);
    expect(r1.probed).toHaveLength(1);
    expect(r1.records).toEqual([
      expect.objectContaining({ supplierId: 'instamart', serviceable: true, checkedAt: NOW }),
    ]);

    const r2 = await getServiceable(
      hospital,
      [new StubSupplier({ now: () => NOW, unserviceablePlaceIds: [hospital.id] })],
      NOW,
    );
    expect(r2.suppliers).toEqual([]);
    expect(r2.records[0]!.serviceable).toBe(false);
  });

  it('a probe that throws is not cached and not serviceable', async () => {
    const { home } = setup();
    const s = new StubSupplier({ now: () => NOW });
    s.checkServiceability = async () => {
      throw new Error('mcp down');
    };
    const r = await getServiceable(home, [s], NOW);
    expect(r.suppliers).toEqual([]);
    expect(r.records).toEqual([]);
  });
});
