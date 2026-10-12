export type * from './core/types.js';
export * from './core/errors.js';
export { lineHash, quoteHash } from './core/hash.js';
export { buildPolicyContext, contextBuilder } from './policy/context.js';
export { capSpend } from './policy/spend.js';
export { formatINR, parseRupees, rupees } from './core/money.js';
export { decide, RULES } from './policy/engine.js';
export { placeWithGate, needsRequote } from './policy/gate.js';
export type { DecisionRecorder, GateContextBuilder, GateRecord, GateResult } from './policy/gate.js';
