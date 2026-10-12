/** Small HTTP helpers shared by the routes: typed errors and body validation. No framework magic. */
import type { AgentDeps } from '../agent/loop.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiDeps extends AgentDeps {
  /** Bearer token required on every route except /health. */
  apiToken: string;
  /** Household used when a request does not name one (v1 is a single household). */
  defaultHouseholdId: string;
}

type Json = Record<string, unknown>;

export function body(raw: unknown): Json {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ApiError(400, 'body must be a JSON object');
  return raw as Json;
}

export function reqString(o: Json, key: string, max = 2000): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') throw new ApiError(400, `${key} must be a non-empty string`);
  if (v.length > max) throw new ApiError(400, `${key} is too long`);
  return v.trim();
}

export function optString(o: Json, key: string, max = 2000): string | undefined {
  return o[key] === undefined || o[key] === null ? undefined : reqString(o, key, max);
}

export function optBool(o: Json, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ApiError(400, `${key} must be a boolean`);
  return v;
}

export function optNumber(o: Json, key: string): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ApiError(400, `${key} must be a number`);
  return v;
}

export function optStringArray(o: Json, key: string): string[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) {
    throw new ApiError(400, `${key} must be an array of non-empty strings`);
  }
  return (v as string[]).map((x) => x.trim());
}

export function householdIdOf(deps: ApiDeps, query: unknown): string {
  const q = (query ?? {}) as Json;
  return typeof q.householdId === 'string' && q.householdId !== '' ? q.householdId : deps.defaultHouseholdId;
}
