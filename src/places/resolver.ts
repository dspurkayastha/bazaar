/**
 * Place resolution, in PRD order: explicit place named in the text > requesting dependant / named dependant
 * (their defaultPlaceId) > context (calendar place, then geofence) > household default.
 * Pure and deterministic; the model never picks the place (agent/tools.ts only echoes this answer).
 */
import type { Household, Member, Place, ShopRequest } from '../core/types.js';

export type PlaceReason = 'explicit' | 'member' | 'context' | 'default';

export interface PlaceResolution {
  placeId: string;
  reason: PlaceReason;
  /** Set when two places tie; the caller must ask before shopping. `placeId` is then the household default. */
  question?: string;
  /** The tied places, when `question` is set. */
  candidates?: string[];
}

/** Geofence radius for lat/lng → place. */
export const GEOFENCE_METRES = 300;

/** Lowercase, drop apostrophes ("Rahul's" → "rahuls"), collapse everything non-alphanumeric to single spaces. */
export function normalisePhrase(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Levenshtein distance, early-exit above `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

interface PhraseMatch {
  /** 1 exact nickname, .95 exact alias, .85 fuzzy nickname, .8 fuzzy alias */
  score: number;
  phrase: string;
}

/** Best match of one phrase (nickname or alias) against the normalised text tokens, or undefined. */
function matchPhrase(tokens: string[], phraseRaw: string, isNickname: boolean): PhraseMatch | undefined {
  const phrase = normalisePhrase(phraseRaw);
  if (phrase.length < 2) return undefined;
  const n = phrase.split(' ').length;
  let best: PhraseMatch | undefined;
  for (let i = 0; i + n <= tokens.length; i++) {
    const window = tokens.slice(i, i + n).join(' ');
    if (window === phrase) return { score: isNickname ? 1 : 0.95, phrase };
    // Fuzzy: one edit, only for phrases long enough that one typo cannot turn it into another word.
    if (phrase.length >= 5 && editDistance(window, phrase, 1) <= 1) {
      best = { score: isNickname ? 0.85 : 0.8, phrase };
    }
  }
  return best;
}

function bestPlaceMatch(tokens: string[], place: Place): PhraseMatch | undefined {
  let best: PhraseMatch | undefined;
  const consider = (m: PhraseMatch | undefined) => {
    if (m && (!best || m.score > best.score || (m.score === best.score && m.phrase.length > best.phrase.length))) {
      best = m;
    }
  };
  consider(matchPhrase(tokens, place.nickname, true));
  for (const a of place.aliases) consider(matchPhrase(tokens, a, false));
  return best;
}

export function haversineMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function defaultPlace(household: Household): Place {
  const p = household.places.find((x) => x.isDefault) ?? household.places[0];
  if (!p) throw new Error(`household ${household.id} has no places`);
  return p;
}

function tie(household: Household, tied: Place[], reason: PlaceReason): PlaceResolution {
  const names = tied.map((p) => p.nickname);
  const list =
    names.length === 2 ? `${names[0]} or ${names[1]}` : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
  return {
    placeId: defaultPlace(household).id,
    reason,
    question: `Which place should this go to: ${list}?`,
    candidates: tied.map((p) => p.id),
  };
}

function nameMentioned(textNorm: string, name: string): boolean {
  const n = normalisePhrase(name);
  if (n.length < 2) return false;
  return new RegExp(`(?:^| )${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`).test(textNorm);
}

export function resolvePlace(request: ShopRequest, household: Household, member: Member): PlaceResolution {
  const textNorm = normalisePhrase(request.text);
  const tokens = textNorm.split(' ').filter(Boolean);

  // 1. Explicit place named in the text.
  const matches = household.places
    .map((place) => ({ place, m: bestPlaceMatch(tokens, place) }))
    .filter((x): x is { place: Place; m: PhraseMatch } => x.m !== undefined);
  if (matches.length > 0) {
    const top = Math.max(...matches.map((x) => x.m.score));
    const winners = matches.filter((x) => x.m.score === top);
    if (winners.length === 1) return { placeId: winners[0]!.place.id, reason: 'explicit' };
    return tie(
      household,
      winners.map((x) => x.place),
      'explicit',
    );
  }

  // 2. Member: a dependant named ("for Ma"), or a dependant requesting.
  const placeById = new Map(household.places.map((p) => [p.id, p]));
  const named = household.members.filter(
    (m) =>
      m.role === 'dependant' && m.defaultPlaceId && placeById.has(m.defaultPlaceId) && nameMentioned(textNorm, m.name),
  );
  if (named.length > 0) {
    const tied = [...new Set(named.map((m) => m.defaultPlaceId!))].map((id) => placeById.get(id)!);
    return tied.length === 1 ? { placeId: tied[0]!.id, reason: 'member' } : tie(household, tied, 'member');
  }
  if (member.role === 'dependant' && member.defaultPlaceId && placeById.has(member.defaultPlaceId)) {
    return { placeId: member.defaultPlaceId, reason: 'member' };
  }

  // 3. Context: calendar place, then geofence (nearest place within 300 m).
  const ctx = request.context;
  if (ctx?.calendarPlaceId && placeById.has(ctx.calendarPlaceId)) {
    return { placeId: ctx.calendarPlaceId, reason: 'context' };
  }
  if (ctx?.lat !== undefined && ctx.lng !== undefined) {
    const here = { lat: ctx.lat, lng: ctx.lng };
    let nearest: { place: Place; d: number } | undefined;
    for (const place of household.places) {
      if (place.lat === undefined || place.lng === undefined) continue;
      const d = haversineMetres(here, { lat: place.lat, lng: place.lng });
      if (d <= GEOFENCE_METRES && (!nearest || d < nearest.d)) nearest = { place, d };
    }
    if (nearest) return { placeId: nearest.place.id, reason: 'context' };
  }

  // 4. Household default.
  return { placeId: defaultPlace(household).id, reason: 'default' };
}
