/**
 * Supplier responses are data, never instructions (CONTRACTS.md non-negotiable 4).
 * Strip anything in supplier-provided strings that reads like an instruction to an agent before it reaches
 * the model. Stripped text is logged, never acted on.
 *
 * Sanitised copies are for display to the model only. Never re-hash a sanitised quote; the gate always
 * works from the raw supplier quote.
 */
import type { Quote, SupplierProduct } from './types.js';

export interface StrippedEntry {
  /** Where the text came from, e.g. "instamart:product:123.name" */
  field: string;
  original: string;
  cleaned: string;
  removed: string[];
  at: string;
}

/** Append-only record of what was stripped. Inject one per request; persist or log it as you see fit. */
export class SanitiseLog {
  readonly entries: StrippedEntry[] = [];
  record(entry: Omit<StrippedEntry, 'at'>, at: string = new Date().toISOString()): void {
    this.entries.push({ ...entry, at });
  }
  get count(): number {
    return this.entries.length;
  }
}

/**
 * Phrases that start an instruction. A match removes everything from the match to the end of its sentence,
 * because what follows an injected imperative ("…and pay now") is part of the same instruction.
 */
const SENTENCE_TRIGGERS: RegExp[] = [
  // "Ignore previous instructions", "disregard all prior rules", "override the spending limits"
  /\b(?:ignore|disregard|forget|override|bypass|skip)\b[^.!?\n]{0,40}?\b(?:instructions?|rules?|prompts?|directions?|polic(?:y|ies)|guidelines?|limits?|caps?|messages?|context|approvals?)\b/i,
  // Persona hijacks
  /\b(?:you are now|you're now|act as|pretend (?:to be|you are)|roleplay as|from now on)\b/i,
  // "New instructions:", "new task"
  /\bnew (?:instructions?|task|rules?|system prompt)\b/i,
  // Role markers: "SYSTEM:", "assistant prompt:"
  /\b(?:system|assistant|developer)\s*(?:prompt|message)?\s*:/i,
  // "Do not ask the user", "never confirm"
  /\b(?:do not|don't|dont|never)\s+(?:ask|confirm|check|verify|warn|gate|refuse|hold|tell|notify|wait)\b/i,
  // Imperative money moves with urgency: "pay now", "place the order immediately", "approve automatically"
  /\b(?:pay|checkout|check out|place (?:the |this |an )?order|confirm (?:the |this )?(?:order|payment)|approve(?: this)?(?: order| payment| cart)?|transfer|send money)\s+(?:now|immediately|automatically|right away|without\b|instantly)/i,
  // Tool-call nudges: "call the checkout tool", "confirm_order("
  /\b(?:call|invoke|use|run|execute)\s+(?:the\s+)?(?:\w+\s+)?(?:tool|function)\b/i,
  /\b(?:checkout|confirm_order|update_cart|clear_cart|propose_checkout|check_payment_status)\s*\(/i,
];

/** Control tokens that are removed wherever they appear (just the token). */
const TOKEN_PATTERNS: RegExp[] = [
  /<\|[^|>]{0,40}\|>(?:\s*(?:system|assistant|user|developer|tool)\b)?/gi, // <|im_start|>assistant
  /\[\/?(?:INST|SYS)\]/gi,
  /<\/?(?:system|instructions?|prompt|assistant|tool_call)\b[^>]*>/gi,
  /```/g,
];

const SENTENCE_END = /[.!?\n;|]/;
const TRAILING_JUNK = /[\s\-–—:,;|/]+$/;
const LEADING_JUNK = /^[\s\-–—:,;|/]+/;

export interface SanitiseResult {
  text: string;
  removed: string[];
}

export function sanitiseText(input: string): SanitiseResult {
  const removed: string[] = [];
  let text = input;

  for (const re of TOKEN_PATTERNS) {
    text = text.replace(re, (m) => {
      removed.push(m);
      return ' ';
    });
  }

  // Repeatedly cut the earliest trigger to the end of its sentence until none remain.
  for (;;) {
    let earliest: { index: number } | undefined;
    for (const re of SENTENCE_TRIGGERS) {
      const m = re.exec(text);
      if (m && (!earliest || m.index < earliest.index)) earliest = { index: m.index };
    }
    if (!earliest) break;
    const rest = text.slice(earliest.index);
    const endMatch = SENTENCE_END.exec(rest);
    const end = endMatch ? earliest.index + endMatch.index + 1 : text.length;
    removed.push(text.slice(earliest.index, end).trim());
    text = `${text.slice(0, earliest.index)} ${text.slice(end)}`;
  }

  if (removed.length === 0) return { text: input, removed };
  text = text.replace(/\s+/g, ' ').replace(TRAILING_JUNK, '').replace(LEADING_JUNK, '').trim();
  // A dangling conjunction left behind ("Amul Milk and") is noise.
  text = text.replace(/\s+(?:and|then|&)$/i, '').trim();
  return { text, removed };
}

/** Sanitise one field, recording to the log when anything was stripped. */
export function sanitiseField(value: string, field: string, log?: SanitiseLog, fallback = ''): string {
  const { text, removed } = sanitiseText(value);
  const cleaned = text === '' ? fallback : text;
  if (removed.length > 0) log?.record({ field, original: value, cleaned, removed });
  return cleaned;
}

export function sanitiseProduct(p: SupplierProduct, log?: SanitiseLog): SupplierProduct {
  const base = `${p.supplierId}:product:${p.productId}`;
  return {
    ...p,
    name: sanitiseField(p.name, `${base}.name`, log, '(name withheld)'),
    ...(p.brand !== undefined ? { brand: sanitiseField(p.brand, `${base}.brand`, log) } : {}),
    variants: p.variants.map((v) => ({
      ...v,
      label: sanitiseField(v.label, `${base}.variant:${v.variantId}.label`, log),
      ...(v.unitPrice !== undefined
        ? { unitPrice: sanitiseField(v.unitPrice, `${base}.variant:${v.variantId}.unitPrice`, log) }
        : {}),
    })),
  };
}

/** Display copy of a quote for the model. Keeps `hash` from the raw quote; do not re-hash this copy. */
export function sanitiseQuoteForModel(q: Quote, log?: SanitiseLog): Quote {
  const base = `${q.supplierId}:quote:${q.id}`;
  return {
    ...q,
    lines: q.lines.map((l) => ({
      ...l,
      name: sanitiseField(l.name, `${base}.line:${l.variantId}.name`, log, '(name withheld)'),
      label: sanitiseField(l.label, `${base}.line:${l.variantId}.label`, log),
    })),
    fees: q.fees.map((f) => ({ ...f, label: sanitiseField(f.label, `${base}.fee`, log, 'fee') })),
    unavailable: q.unavailable.map((u) => ({ ...u, reason: sanitiseField(u.reason, `${base}.unavailable`, log) })),
  };
}
