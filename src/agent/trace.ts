/**
 * Per-request trace: what the loop did, in a shape that is safe to log and to return under `debug`.
 * No tool arguments, no tool results, and every free-text field is scrubbed of credentials, addresses and phone numbers.
 */
import type { Household, Place } from '../core/types.js';

export const MAX_TRACE_MESSAGE = 300;

export interface ToolCallTrace {
  name: string;
  ms: number;
  ok: boolean;
  errorKind?: string;
  errorMessage?: string;
}

export type Outcome = 'quoted' | 'held' | 'paid' | 'blocked' | 'failed' | 'asked';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
}

export interface RequestTelemetry {
  requestId: string;
  placeId: string;
  model: string;
  toolCalls: ToolCallTrace[];
  totalMs: number;
  outcome: Outcome;
  /** Why the loop ended abnormally (budget, wall_time, repeated_error, llm_error, no_final_text), if it did. */
  abnormal?: string;
  /** Present when the provider reported usage. */
  usage?: TokenUsage;
}

/** Strings that must never reach a log: the place addresses and every member's channel address (phone). */
export function sensitiveStrings(household: Household, place: Place): string[] {
  const out = new Set<string>();
  for (const p of [place, ...household.places]) {
    if (p.canonicalAddress.trim().length >= 6) out.add(p.canonicalAddress.trim());
  }
  for (const m of household.members) {
    for (const c of m.channels) if (c.address.trim().length >= 4) out.add(c.address.trim());
  }
  return [...out];
}

export function scrub(text: string, sensitive: string[] = [], max = MAX_TRACE_MESSAGE): string {
  let t = text;
  for (const s of sensitive) t = t.split(s).join('[redacted]');
  t = t
    .replace(/\bmtk_[A-Za-z0-9_-]+/g, '[token]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, '[key]')
    .replace(/\b(bearer|authorization)[:\s]+\S+/gi, '$1 [token]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
