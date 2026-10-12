import type { Place, Profile } from '../core/types.js';

/**
 * The profile that applies when shopping for `place`: the household profile with the place's overlay applied
 * (dependants' places override people count, pantry, recipes, usual lists; defaults merge by item key).
 */
export function effectiveProfile(profile: Profile, place: Place): Profile {
  const o = place.profileOverlay;
  if (!o) return profile;
  const defaults = [...profile.defaults];
  for (const d of o.defaults ?? []) {
    const i = defaults.findIndex((x) => x.key === d.key);
    if (i >= 0) defaults[i] = d;
    else defaults.push(d);
  }
  return {
    ...profile,
    ...(o.peopleDefault !== undefined ? { peopleDefault: o.peopleDefault } : {}),
    ...(o.pantryAssumed !== undefined ? { pantryAssumed: o.pantryAssumed } : {}),
    ...(o.recipes !== undefined ? { recipes: o.recipes } : {}),
    ...(o.usualLists !== undefined ? { usualLists: o.usualLists } : {}),
    ...(o.languageHints !== undefined ? { languageHints: o.languageHints } : {}),
    defaults,
  };
}
