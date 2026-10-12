import { describe, expect, it } from 'vitest';
import type { ItemCategory } from '../src/core/types.js';
import { classify } from '../src/suppliers/instamart/category.js';

const cases: [string, ItemCategory][] = [
  ['Chicken Curry Cut (Bone-in) 500 g', 'meat'],
  ['Farm Fresh Eggs 6 pcs', 'meat'],
  ['Rohu Fish Cleaned', 'meat'],
  ['Amul Taaza Toned Milk', 'dairy'],
  ['Amul Butter 100 g', 'dairy'],
  ['Mother Dairy Fresh Curd', 'dairy'],
  ['Amul Fresh Paneer', 'dairy'],
  ['Onion (Pyaz)', 'produce'],
  ['Fresh Tomato Hybrid', 'produce'],
  ['Banana Robusta', 'produce'],
  ["Lay's India's Magic Masala Chips", 'snacks'],
  ['Britannia Good Day Cookies', 'snacks'],
  ['Cadbury Dairy Milk Chocolate', 'snacks'],
  ['Coca-Cola Soft Drink', 'drinks'],
  ['Real Fruit Power Apple Juice', 'drinks'],
  ['Bisleri Packaged Drinking Water 1 L', 'drinks'],
  ['Surf Excel Matic Detergent Powder', 'household'],
  ['Vim Dishwash Gel', 'household'],
  ['Harpic Toilet Cleaner', 'household'],
  ['Pedigree Chicken & Veg Dog Food', 'pet'],
  ['Whiskas Adult Cat Food', 'pet'],
  ['Prestige Popular Pressure Cooker 5 L', 'appliances'],
  ['Philips Mixer Grinder 750 W', 'appliances'],
  ['Havells Electric Kettle', 'appliances'],
  ['boAt Bluetooth Earphones', 'electronics'],
  ['Mi 20000 mAh Power Bank', 'electronics'],
  ['Type-C USB Charging Cable', 'electronics'],
  ['Crocin Advance Paracetamol Tablets', 'medicine'],
  ['Dettol Antiseptic Liquid', 'medicine'],
  ['ORS Electral Powder', 'medicine'],
  ['Kingfisher Strong Beer Can', 'alcohol'],
  ['Sula Red Wine', 'alcohol'],
  ['Royal Stag Whisky', 'alcohol'],
  ['Classic Regular Cigarettes', 'tobacco'],
  ['Pampers Baby Diapers', 'baby'],
  ['Colgate Strong Teeth Toothpaste', 'personal_care'],
  ['Aashirvaad Whole Wheat Atta 5 kg', 'grocery'],
  ['Daawat Biryani Basmati Rice 1 kg', 'grocery'],
  ['Fortune Sunflower Oil', 'grocery'],
  ['Zorblax Quantum Widget', 'other'],
  ['', 'other'],
];

describe('instamart category classifier', () => {
  it.each(cases)('%s -> %s', (name, expected) => {
    expect(classify(name)).toBe(expected);
  });

  it('does not misfire on near-misses', () => {
    expect(classify('Ginger Beer Bottle')).not.toBe('alcohol');
    expect(classify('White Wine Vinegar')).not.toBe('alcohol');
    expect(classify('Peanut Butter Crunchy')).toBe('grocery');
    expect(classify('Coconut Milk 400 ml')).toBe('grocery');
    expect(classify('Dishwasher Tablets')).toBe('household');
    expect(classify('Tomato Ketchup')).toBe('grocery');
  });

  it('uses the brand as well as the name', () => {
    expect(classify('Strong 500 ml', 'Kingfisher')).toBe('alcohol');
  });
});
