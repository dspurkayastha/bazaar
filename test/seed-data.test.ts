import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, foundingHousehold } from '../src/db/seed-data.js';

const tools = JSON.parse(readFileSync(new URL('../docs/instamart-tools.json', import.meta.url), 'utf8')) as {
  tools: { get_addresses: { sample_ids: string[] } };
};
const sampleIds = tools.tools.get_addresses.sample_ids.map((s) => s.split(' ')[0]);

describe('founding household seed data', () => {
  const h = foundingHousehold();

  it('has the owner and adder', () => {
    expect(h.name).toBe('Shome Purkayastha');
    expect(h.members.map((m) => [m.name, m.role])).toEqual([
      ['Dev', 'owner'],
      ['Partner', 'adder'],
    ]);
    expect(h.members[0]!.channels[0]!.kind).toBe('whatsapp');
    // Only Dev's own WhatsApp is trusted to pay via the webhook; the adder's never is.
    expect(h.members[0]!.channels[0]!.trusted).toBe(true);
    expect(h.members[1]!.channels.some((c) => c.trusted)).toBe(false);
  });

  it('has exactly the four Instamart places from the sample ids', () => {
    expect(h.places.map((p) => p.supplierAddressIds.instamart)).toEqual(sampleIds);
    expect(h.places.map((p) => [p.nickname, p.trusted, p.isDefault])).toEqual([
      ['home', true, true],
      ['hospital', false, false],
      ["rahul's", false, false],
      ["didi's", false, false],
    ]);
    expect(h.places.find((p) => p.nickname === "didi's")!.city).toBe('Kolkata');
    expect(h.places.find((p) => p.nickname === 'hospital')!.aliases).toEqual(['work', 'SCC', 'cancer centre']);
  });

  it('carries the PRD policy defaults in paise', () => {
    expect(h.policy).toEqual(DEFAULT_POLICY);
    expect(h.policy.perOrderUnattendedMax).toBe(50_000);
    expect(h.policy.dailyUnattendedMax).toBe(150_000);
    expect(h.policy.monthlyMax).toBe(800_000);
    expect(h.policy.blockedUnitPriceOver).toBe(300_000);
    expect(h.policy.blockedCategories).toContain('appliances');
    expect(h.policy.unattendedCategories).not.toContain('meat');
  });

  it('has the stated defaults, with meat never substituted', () => {
    const byKey = Object.fromEntries(h.profile.defaults.map((d) => [d.key, d]));
    for (const k of ['milk', 'curd', 'dettol', 'biryani rice', 'chicken', 'mutton', 'dessert', 'dog chews']) {
      expect(byKey[k], k).toBeDefined();
    }
    expect(byKey['chicken']!.neverSubstitute).toBe(true);
    expect(byKey['mutton']!.neverSubstitute).toBe(true);
    expect(byKey['milk']!.size).toBe('250 ml x 4');
    expect([byKey['dessert']!.brand, byKey['dessert']!.product, byKey['dessert']!.size]).toEqual([
      'Vadilal',
      'American Nuts',
      '1 L',
    ]);
    expect([byKey['curd']!.brand, byKey['curd']!.product]).toEqual(['Purabi', 'Cup Sweetened']);
    // Every recipe item resolves to a default.
    for (const item of h.profile.recipes[0]!.items) expect(byKey[item.key], item.key).toBeDefined();
    expect(h.profile.recipes[0]!.servesDefault).toBe(2);
  });
});
