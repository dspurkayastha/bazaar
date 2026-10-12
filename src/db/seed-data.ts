/**
 * The founding household, as plain data (no I/O) so it can be tested and reused by fixtures.
 * Source: PRD instruction block + docs/instamart-tools.json sample_ids. Amounts in paise.
 */
import { newId } from '../core/ids.js';
import type { Household, ItemDefault, PolicyConfig, Profile } from '../core/types.js';

export const DEFAULT_POLICY: PolicyConfig = {
  perOrderUnattendedMax: 50_000, // ₹500
  dailyUnattendedMax: 150_000, // ₹1,500
  monthlyMax: 800_000, // ₹8,000
  unattendedCategories: ['grocery', 'dairy', 'produce', 'snacks', 'drinks', 'household', 'pet'],
  blockedCategories: ['alcohol', 'tobacco', 'medicine', 'electronics', 'appliances', 'gift_card'],
  blockedUnitPriceOver: 300_000, // ₹3,000 per unit
  quantityBoundMultiplier: 2,
};

/** Instamart saved-address ids from docs/instamart-tools.json (get_addresses.sample_ids). */
export const INSTAMART_ADDRESS_IDS = {
  home: 'd4qog5cbifjahfg3lj7g__AXrN3QWH1x4X8mV9ooN8Qx',
  hospital: 'd7uqnko0hph36i9dkpag__AXoSkwWH9u4vVXa2sDMjhK',
  rahuls: 'd9icgks1d96hnppuqtjg__AXolagWIBcs7fofoMCfq9g',
  didis: '4661350__AVjo1QVE6QwX7C7RoURA6O',
} as const;

/** `brand` is the maker, `product` the line within the brand, `size` the pack (plus cut where relevant). */
const DEFAULTS: ItemDefault[] = [
  {
    key: 'milk',
    aliases: ['dudh', 'doodh', 'lactose free milk'],
    brand: 'Amul',
    product: 'Lactose Free',
    size: '250 ml x 4',
    category: 'dairy',
    origin: 'stated',
  },
  {
    key: 'curd',
    aliases: ['doi', 'dahi', 'mishti doi', 'sweet curd'],
    brand: 'Purabi',
    product: 'Cup Sweetened',
    size: '400 g',
    category: 'dairy',
    origin: 'stated',
  },
  {
    key: 'dettol',
    aliases: ['antiseptic', 'antiseptic liquid'],
    brand: 'Dettol',
    product: 'Antiseptic Liquid',
    size: '500 ml',
    category: 'household',
    origin: 'stated',
  },
  {
    key: 'biryani rice',
    aliases: ['basmati', 'basmati rice', 'rice for biryani'],
    brand: 'Daawat',
    product: 'Biryani',
    size: '1 kg',
    quantityPerHead: 0.5,
    category: 'grocery',
    origin: 'stated',
  },
  {
    key: 'chicken',
    aliases: ['murgi', 'chicken curry cut'],
    brand: 'Meatzza',
    product: 'Chicken Curry Cut (Bone-in)',
    size: '500 g',
    quantityPerHead: 0.5, // 500 g per 2 people
    category: 'meat',
    neverSubstitute: true,
    origin: 'stated',
  },
  {
    key: 'mutton',
    aliases: ['goat', 'mangsho', 'mutton curry cut'],
    product: 'Mutton Curry Cut',
    size: '500 g',
    quantityPerHead: 0.5, // 500 g per 2 people
    category: 'meat',
    neverSubstitute: true,
    origin: 'stated',
  },
  {
    key: 'dessert',
    aliases: ['ice cream', 'something sweet'],
    brand: 'Vadilal',
    product: 'American Nuts',
    size: '1 L',
    category: 'snacks',
    origin: 'stated',
  },
  {
    key: 'dog chews',
    aliases: ['chew bones', 'dog bones', 'chews'],
    brand: 'Purepet',
    product: 'Pressed Chew Bones',
    category: 'pet',
    origin: 'stated',
  },
  // Recipe-only items (biryani template) that need a brand/size to be bought correctly.
  {
    key: 'biryani masala',
    aliases: ['shahi biryani masala'],
    brand: 'Everest',
    product: 'Shahi Biryani Masala',
    size: '50 g',
    category: 'grocery',
    origin: 'stated',
  },
  { key: 'ghee', aliases: [], size: '200 ml', category: 'dairy', origin: 'stated' },
  {
    key: 'plain curd',
    aliases: ['curd for marinade', 'unsweetened curd', 'plain dahi'],
    size: '400 g',
    category: 'dairy',
    origin: 'stated',
  },
  { key: 'mint', aliases: ['pudina'], size: '1 bunch', category: 'produce', origin: 'stated' },
];

export function foundingHousehold(id: (prefix: string) => string = newId): Household {
  const householdId = id('hh');
  const profile: Profile = {
    householdId,
    peopleDefault: 2,
    pantryAssumed: ['oil', 'salt', 'onions', 'ginger-garlic', 'chillies', 'basic masalas'],
    defaults: DEFAULTS.map((d) => ({ ...d, aliases: [...d.aliases] })),
    recipes: [
      {
        name: 'biryani',
        aliases: ['chicken biryani'],
        servesDefault: 2,
        items: [
          { key: 'biryani rice', quantityPerHead: 0.5 },
          { key: 'chicken', quantityPerHead: 0.5 },
          { key: 'biryani masala' },
          { key: 'ghee' },
          { key: 'plain curd' },
          { key: 'mint' },
        ],
      },
    ],
    usualLists: [],
    languageHints: ['en', 'bn', 'hi'],
  };

  return {
    id: householdId,
    name: 'Shome Purkayastha',
    members: [
      {
        id: id('mem'),
        householdId,
        name: 'Dev',
        role: 'owner',
        channels: [{ kind: 'whatsapp', address: '+910000000001' }], // placeholder
      },
      {
        id: id('mem'),
        householdId,
        name: 'Partner',
        role: 'adder',
        channels: [{ kind: 'whatsapp', address: '+910000000002' }], // placeholder
      },
    ],
    places: [
      {
        id: id('pl'),
        householdId,
        nickname: 'home',
        aliases: ['house', 'ambicapatty'],
        canonicalAddress: 'Home, Ambicapatty, Silchar',
        city: 'Silchar',
        supplierAddressIds: { instamart: INSTAMART_ADDRESS_IDS.home },
        serviceability: [],
        trusted: true,
        isDefault: true,
      },
      {
        id: id('pl'),
        householdId,
        nickname: 'hospital',
        aliases: ['work', 'SCC', 'cancer centre'],
        canonicalAddress: 'Work, Silchar Cancer Centre (SCC), Silchar',
        city: 'Silchar',
        supplierAddressIds: { instamart: INSTAMART_ADDRESS_IDS.hospital },
        serviceability: [],
        trusted: false,
        isDefault: false,
      },
      {
        id: id('pl'),
        householdId,
        nickname: "rahul's",
        aliases: [],
        canonicalAddress: "Rahul's House, Silchar",
        city: 'Silchar',
        supplierAddressIds: { instamart: INSTAMART_ADDRESS_IDS.rahuls },
        serviceability: [],
        trusted: false,
        isDefault: false,
      },
      {
        id: id('pl'),
        householdId,
        nickname: "didi's",
        aliases: ['didiya', 'kolkata'],
        canonicalAddress: 'Didiya, Kolkata',
        city: 'Kolkata',
        supplierAddressIds: { instamart: INSTAMART_ADDRESS_IDS.didis },
        serviceability: [],
        trusted: false,
        isDefault: false,
      },
    ],
    profile,
    policy: { ...DEFAULT_POLICY },
  };
}
