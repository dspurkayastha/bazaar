/**
 * Deterministic text → item keys. Pure helpers; no I/O, no model.
 *
 *  - maps words to Profile.defaults keys through key + aliases (vernacular included: "doi" → curd),
 *  - detects recipe mentions ("making biryani", "biryani for 6") and expands them through RecipeTemplate,
 *    scaled by people,
 *  - parses quantities ("2 packs", "a kilo", "half a kilo", "500 g"),
 *  - detects "the usual" and usual-list names.
 *
 * The result is a hint for the model, never a decision: it does the rest (variant choice, anything unmatched).
 */
import type { ItemCategory, ItemDefault, Profile, RecipeTemplate } from '../core/types.js';

export type QuantityUnit = 'pack' | 'kg' | 'g' | 'l' | 'ml' | 'dozen' | 'piece';

export interface Quantity {
  amount: number;
  /** Absent for a bare count ("2 milk"). */
  unit?: QuantityUnit;
}

export interface NormalisedItem {
  key: string;
  /** The words in the text that matched ("doi"). */
  matched: string;
  category: ItemCategory;
  quantity?: Quantity;
  /** Packs of the profile's default size that satisfy `quantity` (e.g. "a kilo" of 500 g chicken → 2). */
  packs?: number;
}

export interface RecipeLine {
  key: string;
  /** Packs of the default size (or units) to buy. */
  quantity: number;
  optional: boolean;
}

export interface NormalisedRecipe {
  name: string;
  matched: string;
  people: number;
  peopleSource: 'stated' | 'default';
  lines: RecipeLine[];
  /** Template items the household is assumed to have already ("oil", "salt"). */
  skippedPantry: string[];
}

export interface UsualMatch {
  /** The text said "the usual" without naming a list. */
  generic: boolean;
  lists: { name: string; items: { key: string; quantity: number }[] }[];
  /** "the usual" with more than one list and none named. */
  ambiguous: boolean;
}

export interface Normalised {
  items: NormalisedItem[];
  recipes: NormalisedRecipe[];
  usual?: UsualMatch;
}

// ---------- text prep ----------

const MASK = '\u0000';

/** Lowercase tokens; apostrophes dropped; decimals kept ("1.5" stays one token). */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/(\d)\.(\d)/g, '$1‡$2')
    .replace(/[^\p{L}\p{N}‡]+/gu, ' ')
    .replace(/‡/g, '.')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function phraseTokens(s: string): string[] {
  return tokenise(s);
}

// ---------- quantities ----------

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  couple: 2,
  dozen: 12,
  half: 0.5,
};

const UNITS: Record<string, QuantityUnit> = {
  pack: 'pack',
  packs: 'pack',
  packet: 'pack',
  packets: 'pack',
  pkt: 'pack',
  pkts: 'pack',
  tub: 'pack',
  tubs: 'pack',
  box: 'pack',
  boxes: 'pack',
  bottle: 'pack',
  bottles: 'pack',
  cup: 'pack',
  cups: 'pack',
  bunch: 'pack',
  bunches: 'pack',
  kg: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  g: 'g',
  gm: 'g',
  gms: 'g',
  gram: 'g',
  grams: 'g',
  l: 'l',
  ltr: 'l',
  ltrs: 'l',
  litre: 'l',
  litres: 'l',
  liter: 'l',
  liters: 'l',
  ml: 'ml',
  piece: 'piece',
  pieces: 'piece',
  pc: 'piece',
  pcs: 'piece',
};

function numberOf(tok: string | undefined): number | undefined {
  if (tok === undefined) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(tok)) return Number(tok);
  return NUMBER_WORDS[tok];
}

/**
 * Parse a quantity phrase made of whole tokens: "2 packs", "a kilo", "half a kilo", "500 g", "1.5 litres",
 * "two", "x2", "dozen". Returns undefined when the tokens are not exactly a quantity.
 */
export function parseQuantity(fragment: string | string[]): Quantity | undefined {
  const t = (Array.isArray(fragment) ? fragment : tokenise(fragment)).filter((x) => x !== 'of');
  if (t.length === 0) return undefined;
  // "x2" / "2x"
  if (t.length === 1) {
    const m = /^x(\d+)$|^(\d+)x$/.exec(t[0]!);
    if (m) return { amount: Number(m[1] ?? m[2]) };
  }
  // "500g", "2kg"
  if (t.length === 1) {
    const m = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(t[0]!);
    if (m && UNITS[m[2]!]) return { amount: Number(m[1]), unit: UNITS[m[2]!]! };
  }
  let i = 0;
  let amount: number | undefined;
  if (t[0] === 'half') {
    amount = 0.5;
    i = 1;
    if (t[i] === 'a' || t[i] === 'an') i++;
  } else if (t[0] === 'dozen' || t[0] === 'couple') {
    amount = NUMBER_WORDS[t[0]];
    i = 1;
    if (t[0] === 'dozen') return t.length === 1 ? { amount: 12 } : undefined;
  } else {
    amount = numberOf(t[0]);
    i = 1;
    // "a dozen", "a couple"
    if ((t[0] === 'a' || t[0] === 'an') && t[1] === 'dozen' && t.length === 2) return { amount: 12 };
  }
  if (amount === undefined) return undefined;
  if (i === t.length) return { amount };
  const unit = UNITS[t[i]!];
  if (!unit || i + 1 !== t.length) return undefined;
  return { amount, unit };
}

interface Size {
  /** grams, millilitres or a bare count */
  amount: number;
  family: 'mass' | 'volume' | 'count';
}

/** "500 g" → 500 mass; "250 ml x 4" → 1000 volume; "1 L" → 1000 volume; "1 bunch" → 1 count. */
export function parseSize(size: string | undefined): Size | undefined {
  if (!size) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)(?:\s*[x×]\s*(\d+))?\s*$/.exec(size);
  if (!m) return undefined;
  const n = Number(m[1]) * (m[3] ? Number(m[3]) : 1);
  const unit = UNITS[m[2]!.toLowerCase()];
  switch (unit) {
    case 'kg':
      return { amount: n * 1000, family: 'mass' };
    case 'g':
      return { amount: n, family: 'mass' };
    case 'l':
      return { amount: n * 1000, family: 'volume' };
    case 'ml':
      return { amount: n, family: 'volume' };
    default:
      return { amount: n, family: 'count' };
  }
}

/** How many packs of `size` cover `qty`. Undefined when the units cannot be compared. */
export function packsFor(size: string | undefined, qty: Quantity): number | undefined {
  if (qty.unit === undefined || qty.unit === 'pack' || qty.unit === 'piece') return Math.max(1, Math.ceil(qty.amount));
  const s = parseSize(size);
  if (!s || s.family === 'count') return undefined;
  const wanted =
    qty.unit === 'kg'
      ? { family: 'mass', n: qty.amount * 1000 }
      : qty.unit === 'g'
        ? { family: 'mass', n: qty.amount }
        : qty.unit === 'l'
          ? { family: 'volume', n: qty.amount * 1000 }
          : qty.unit === 'ml'
            ? { family: 'volume', n: qty.amount }
            : undefined;
  if (!wanted || wanted.family !== s.family) return undefined;
  return Math.max(1, Math.ceil(wanted.n / s.amount - 1e-9));
}

// ---------- phrase index ----------

type Target =
  | { kind: 'item'; def: ItemDefault }
  | { kind: 'recipe'; recipe: RecipeTemplate }
  | { kind: 'usual'; list: Profile['usualLists'][number] };

interface Phrase {
  tokens: string[];
  target: Target;
}

function buildIndex(profile: Profile): Phrase[] {
  const out: Phrase[] = [];
  for (const def of profile.defaults) {
    for (const p of [def.key, ...def.aliases]) {
      const tokens = phraseTokens(p);
      if (tokens.length > 0) out.push({ tokens, target: { kind: 'item', def } });
    }
  }
  for (const recipe of profile.recipes) {
    for (const p of [recipe.name, ...recipe.aliases]) {
      const tokens = phraseTokens(p);
      if (tokens.length > 0) out.push({ tokens, target: { kind: 'recipe', recipe } });
    }
  }
  // Longest phrase first, so "biryani rice" beats "biryani" and "mishti doi" beats "doi".
  return out.sort((a, b) => b.tokens.length - a.tokens.length || b.tokens.join(' ').length - a.tokens.join(' ').length);
}

function matchAt(tokens: string[], at: number, phrase: string[]): boolean {
  if (at + phrase.length > tokens.length) return false;
  return phrase.every((w, k) => tokens[at + k] === w);
}

/** "for 6", "for six people", "for 4 persons", "serves 8". Returns [people, tokensConsumed]. */
function parsePeopleAfter(tokens: string[], at: number): [number, number] | undefined {
  const w = tokens[at];
  if (w === 'for' || w === 'serves' || w === 'serving') {
    const n = numberOf(tokens[at + 1]);
    if (n !== undefined && n >= 1 && Number.isInteger(n) && tokens[at + 1] !== 'a' && tokens[at + 1] !== 'an') {
      let used = 2;
      if (/^(people|persons|person|guests|guest|pax|adults)$/.test(tokens[at + 2] ?? '')) used = 3;
      else if (tokens[at + 2] === 'of' && /^(us|them)$/.test(tokens[at + 3] ?? '')) used = 4;
      return [n, used];
    }
  }
  return undefined;
}

const QTY_UNIT_RE = Object.keys(UNITS).join('|');
const AFTER_QTY_RE = new RegExp(
  `^(?:x\\d+|\\d+x|\\d+(?:\\.\\d+)?(?:${QTY_UNIT_RE})|\\d+(?:\\.\\d+)? (?:${QTY_UNIT_RE}))\\b`,
);

/** Quantity immediately before an item match (up to 4 tokens: "half a kilo of"). */
function quantityBefore(tokens: string[], at: number): { qty: Quantity; start: number } | undefined {
  for (let len = Math.min(4, at); len >= 1; len--) {
    const slice = tokens.slice(at - len, at);
    if (slice.includes(MASK)) continue;
    const q = parseQuantity(slice);
    // A lone "a"/"an" only counts when it is clearly the article right before the item.
    if (q) return { qty: q, start: at - len };
  }
  return undefined;
}

/** "milk x2", "milk 2 packs", "curd 500 g" — needs an explicit marker or unit so "milk 2 curd" stays unparsed. */
function quantityAfter(tokens: string[], at: number): { qty: Quantity; end: number } | undefined {
  const rest = tokens.slice(at, at + 3);
  if (rest.includes(MASK) && rest[0] === MASK) return undefined;
  const joined = rest.join(' ');
  if (!AFTER_QTY_RE.test(joined)) return undefined;
  for (let len = Math.min(2, rest.length); len >= 1; len--) {
    const q = parseQuantity(rest.slice(0, len));
    if (q && (q.unit !== undefined || /^x\d+$|^\d+x$/.test(rest[0]!))) return { qty: q, end: at + len };
  }
  return undefined;
}

// ---------- main ----------

const USUAL_RE = /\b(?:the )?usual\b/;

export function normalise(text: string, profile: Profile): Normalised {
  const tokens = tokenise(text);
  const index = buildIndex(profile);
  const taken: boolean[] = tokens.map(() => false);
  const found: { at: number; len: number; target: Target }[] = [];

  // Greedy longest-first, non-overlapping.
  for (const phrase of index) {
    for (let i = 0; i < tokens.length; i++) {
      const len = phrase.tokens.length;
      if (!matchAt(tokens, i, phrase.tokens)) continue;
      if (taken.slice(i, i + len).some(Boolean)) continue;
      for (let k = i; k < i + len; k++) taken[k] = true;
      found.push({ at: i, len, target: phrase.target });
    }
  }
  found.sort((a, b) => a.at - b.at);

  // Mask recipe words and their "for N people" so numbers are not mistaken for item quantities.
  const masked = [...tokens];
  const recipes: NormalisedRecipe[] = [];
  for (const f of found) {
    if (f.target.kind !== 'recipe') continue;
    for (let k = f.at; k < f.at + f.len; k++) masked[k] = MASK;
    const recipe = f.target.recipe;
    let people = profile.peopleDefault;
    let peopleSource: 'stated' | 'default' = 'default';
    const after = parsePeopleAfter(tokens, f.at + f.len);
    if (after) {
      [people] = after;
      peopleSource = 'stated';
      for (let k = f.at + f.len; k < f.at + f.len + after[1]; k++) masked[k] = MASK;
    }
    recipes.push(expandRecipe(recipe, tokens.slice(f.at, f.at + f.len).join(' '), people, peopleSource, profile));
  }

  const items: NormalisedItem[] = [];
  for (const f of found) {
    if (f.target.kind !== 'item') continue;
    const def = f.target.def;
    const item: NormalisedItem = {
      key: def.key,
      matched: tokens.slice(f.at, f.at + f.len).join(' '),
      category: def.category,
    };
    const before = quantityBefore(masked, f.at);
    const after = before ? undefined : quantityAfter(masked, f.at + f.len);
    const qty = before?.qty ?? after?.qty;
    if (qty) {
      item.quantity = qty;
      const packs = packsFor(def.size, qty);
      if (packs !== undefined) item.packs = packs;
      // Consume so the same number is not read as the next item's quantity.
      if (before) for (let k = before.start; k < f.at; k++) masked[k] = MASK;
      if (after) for (let k = f.at + f.len; k < after.end; k++) masked[k] = MASK;
    }
    items.push(item);
  }

  const result: Normalised = { items, recipes };
  const usual = detectUsual(text, profile);
  if (usual) result.usual = usual;
  return result;
}

function expandRecipe(
  recipe: RecipeTemplate,
  matched: string,
  people: number,
  peopleSource: 'stated' | 'default',
  profile: Profile,
): NormalisedRecipe {
  const pantry = new Set(profile.pantryAssumed.map((p) => p.toLowerCase()));
  const lines: RecipeLine[] = [];
  const skippedPantry: string[] = [];
  for (const it of recipe.items) {
    if (pantry.has(it.key.toLowerCase())) {
      skippedPantry.push(it.key);
      continue;
    }
    const def = profile.defaults.find((d) => d.key === it.key);
    const perHead = it.quantityPerHead ?? def?.quantityPerHead;
    const quantity = perHead !== undefined ? Math.max(1, Math.ceil(perHead * people - 1e-9)) : 1;
    lines.push({ key: it.key, quantity, optional: it.optional ?? false });
  }
  return { name: recipe.name, matched, people, peopleSource, lines, skippedPantry };
}

/** "the usual", "usual", or a usual-list name ("weekly staples", "my breakfast list"). */
export function detectUsual(text: string, profile: Profile): UsualMatch | undefined {
  const norm = tokenise(text).join(' ');
  const named = profile.usualLists.filter((l) => {
    const n = tokenise(l.name).join(' ');
    return n.length > 0 && new RegExp(`(?:^| )${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`).test(norm);
  });
  const generic = USUAL_RE.test(norm);
  if (named.length === 0 && !generic) return undefined;
  if (named.length > 0) {
    return { generic, lists: named.map((l) => ({ name: l.name, items: l.items })), ambiguous: false };
  }
  const lists = profile.usualLists.map((l) => ({ name: l.name, items: l.items }));
  return { generic: true, lists, ambiguous: lists.length > 1 };
}

/** Convenience: the item key a single word or phrase maps to, if any. */
export function itemKeyFor(profile: Profile, phrase: string): string | undefined {
  const t = tokenise(phrase).join(' ');
  for (const d of profile.defaults) {
    if ([d.key, ...d.aliases].some((a) => tokenise(a).join(' ') === t)) return d.key;
  }
  return undefined;
}
