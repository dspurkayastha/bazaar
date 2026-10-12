import { describe, expect, it } from 'vitest';
import type { Profile } from '../src/core/types.js';
import { itemKeyFor, normalise, packsFor, parseQuantity, parseSize } from '../src/profile/normaliser.js';
import { household } from './fixtures/context.js';

const profile = (): Profile => ({
  ...household().profile,
  usualLists: [
    {
      name: 'weekly staples',
      items: [
        { key: 'milk', quantity: 2 },
        { key: 'curd', quantity: 1 },
      ],
    },
  ],
});

describe('parseQuantity', () => {
  it.each([
    ['2 packs', { amount: 2, unit: 'pack' }],
    ['a kilo', { amount: 1, unit: 'kg' }],
    ['half a kilo', { amount: 0.5, unit: 'kg' }],
    ['500 g', { amount: 500, unit: 'g' }],
    ['500g', { amount: 500, unit: 'g' }],
    ['1.5 litres', { amount: 1.5, unit: 'l' }],
    ['two', { amount: 2 }],
    ['x3', { amount: 3 }],
    ['a dozen', { amount: 12 }],
    ['2 packs of', { amount: 2, unit: 'pack' }],
  ])('%s', (text, expected) => {
    expect(parseQuantity(text)).toEqual(expected);
  });

  it('rejects non-quantities', () => {
    expect(parseQuantity('milk')).toBeUndefined();
    expect(parseQuantity('2 milk')).toBeUndefined();
    expect(parseQuantity('')).toBeUndefined();
  });
});

describe('sizes and packs', () => {
  it('parses default sizes', () => {
    expect(parseSize('250 ml x 4')).toEqual({ amount: 1000, family: 'volume' });
    expect(parseSize('500 g')).toEqual({ amount: 500, family: 'mass' });
    expect(parseSize('1 L')).toEqual({ amount: 1000, family: 'volume' });
    expect(parseSize('1 bunch')).toEqual({ amount: 1, family: 'count' });
  });

  it('converts a weight into packs of the default size', () => {
    expect(packsFor('500 g', { amount: 1, unit: 'kg' })).toBe(2);
    expect(packsFor('500 g', { amount: 750, unit: 'g' })).toBe(2);
    expect(packsFor('250 ml x 4', { amount: 2, unit: 'l' })).toBe(2);
    expect(packsFor('500 g', { amount: 3 })).toBe(3);
    expect(packsFor('500 g', { amount: 2, unit: 'l' })).toBeUndefined();
  });
});

describe('normalise: items', () => {
  it('maps vernacular aliases to item keys', () => {
    const r = normalise('doi aur dudh chahiye', profile());
    expect(r.items.map((i) => i.key)).toEqual(['curd', 'milk']);
    expect(r.items[0]!.matched).toBe('doi');
  });

  it('"doi" → curd, and "mishti doi" is still curd, not two matches', () => {
    expect(itemKeyFor(profile(), 'doi')).toBe('curd');
    const r = normalise('get mishti doi', profile());
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.key).toBe('curd');
  });

  it('parses quantities in front of and after items', () => {
    const r = normalise('2 packs of milk, a kilo of chicken, dettol x2', profile());
    const by = Object.fromEntries(r.items.map((i) => [i.key, i]));
    expect(by.milk!.quantity).toEqual({ amount: 2, unit: 'pack' });
    expect(by.milk!.packs).toBe(2);
    expect(by.chicken!.quantity).toEqual({ amount: 1, unit: 'kg' });
    expect(by.chicken!.packs).toBe(2); // 500 g packs
    expect(by.dettol!.quantity).toEqual({ amount: 2 });
  });

  it('leaves quantity undefined when none is stated', () => {
    const r = normalise('need milk', profile());
    expect(r.items[0]!.quantity).toBeUndefined();
  });

  it('the longest alias wins: "biryani rice" is the item, not the recipe', () => {
    const r = normalise('need biryani rice', profile());
    expect(r.recipes).toEqual([]);
    expect(r.items.map((i) => i.key)).toEqual(['biryani rice']);
  });

  it('ignores words it does not know', () => {
    const r = normalise('some random thing', profile());
    expect(r.items).toEqual([]);
    expect(r.recipes).toEqual([]);
    expect(r.usual).toBeUndefined();
  });
});

describe('normalise: recipes', () => {
  it('biryani for 6 expands and scales by people', () => {
    const r = normalise('biryani for 6', profile());
    expect(r.recipes).toHaveLength(1);
    const rec = r.recipes[0]!;
    expect(rec.people).toBe(6);
    expect(rec.peopleSource).toBe('stated');
    const q = Object.fromEntries(rec.lines.map((l) => [l.key, l.quantity]));
    expect(q['biryani rice']).toBe(3); // 0.5 per head × 6, 1 kg packs
    expect(q.chicken).toBe(3); // 0.5 per head × 6, 500 g packs
    expect(q['biryani masala']).toBe(1);
    expect(q.ghee).toBe(1);
    // The people count is consumed, not read as a quantity of anything.
    expect(r.items).toEqual([]);
  });

  it('"making biryani" with no count uses the household default', () => {
    const r = normalise('making biryani tonight', profile());
    const rec = r.recipes[0]!;
    expect(rec.people).toBe(2);
    expect(rec.peopleSource).toBe('default');
    expect(rec.lines.find((l) => l.key === 'chicken')!.quantity).toBe(1);
  });

  it('"chicken biryani for four people" matches the recipe alias, not the chicken item', () => {
    const r = normalise('chicken biryani for four people', profile());
    expect(r.recipes[0]!.people).toBe(4);
    expect(r.items).toEqual([]);
  });

  it('skips pantry-assumed template items', () => {
    const p = profile();
    p.recipes[0]!.items.push({ key: 'oil' });
    const r = normalise('biryani', p);
    expect(r.recipes[0]!.skippedPantry).toEqual(['oil']);
    expect(r.recipes[0]!.lines.some((l) => l.key === 'oil')).toBe(false);
  });

  it('a recipe and an explicit item in one message', () => {
    const r = normalise('biryani for 6 and 2 doi', profile());
    expect(r.recipes[0]!.people).toBe(6);
    expect(r.items).toEqual([expect.objectContaining({ key: 'curd', quantity: { amount: 2 } })]);
  });
});

describe('normalise: the usual', () => {
  it('"the usual" with one list returns it', () => {
    const r = normalise('the usual please', profile());
    expect(r.usual).toMatchObject({ generic: true, ambiguous: false });
    expect(r.usual!.lists.map((l) => l.name)).toEqual(['weekly staples']);
  });

  it('a list named in the text', () => {
    const r = normalise('order my weekly staples', profile());
    expect(r.usual!.lists[0]!.items).toEqual([
      { key: 'milk', quantity: 2 },
      { key: 'curd', quantity: 1 },
    ]);
  });

  it('"the usual" with several lists is flagged ambiguous', () => {
    const p = profile();
    p.usualLists.push({ name: 'party', items: [{ key: 'dessert', quantity: 2 }] });
    const r = normalise('the usual', p);
    expect(r.usual!.ambiguous).toBe(true);
    expect(r.usual!.lists).toHaveLength(2);
  });

  it('"the usual" with no lists returns an empty set for the model to resolve', () => {
    const p = profile();
    p.usualLists = [];
    expect(normalise('the usual', p).usual).toEqual({ generic: true, lists: [], ambiguous: false });
  });
});
