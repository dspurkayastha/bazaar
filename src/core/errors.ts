import type { PolicyDecision, SupplierId } from './types.js';

/** Base class so callers can catch every Bazaar error with one instanceof. */
export class BazaarError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

function describe(decision: PolicyDecision): string {
  return decision.reasons.map((r) => `${r.rule}: ${r.detail}`).join('; ');
}

/** The gate refused to pay until an owner approves this exact quote hash. */
export class PolicyHold extends BazaarError {
  readonly decision: PolicyDecision;
  readonly quoteHash: string;
  constructor(decision: PolicyDecision, quoteHash: string) {
    super('POLICY_HOLD', `Held for owner approval: ${describe(decision)}`);
    this.decision = decision;
    this.quoteHash = quoteHash;
  }
}

/** The gate refused outright; no approval can unlock this quote. */
export class PolicyBlock extends BazaarError {
  readonly decision: PolicyDecision;
  readonly quoteHash: string;
  constructor(decision: PolicyDecision, quoteHash: string) {
    super('POLICY_BLOCK', `Blocked: ${describe(decision)}`);
    this.decision = decision;
    this.quoteHash = quoteHash;
  }
}

/** The live supplier cart no longer matches the quote that was shown. Re-quote. */
export class QuoteMismatch extends BazaarError {
  readonly expectedHash: string;
  readonly actualHash: string;
  constructor(expectedHash: string, actualHash: string, detail?: string) {
    super(
      'QUOTE_MISMATCH',
      `Live cart ${actualHash} does not match quote ${expectedHash}${detail ? `: ${detail}` : ''}`,
    );
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/** A supplier call failed or returned something unusable. */
export class SupplierError extends BazaarError {
  readonly supplierId: SupplierId;
  readonly operation: string;
  /** True when retrying is known to be safe (never true for checkout). */
  readonly retryable: boolean;
  constructor(
    supplierId: SupplierId,
    operation: string,
    message: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super('SUPPLIER_ERROR', `${supplierId}.${operation}: ${message}`, options);
    this.supplierId = supplierId;
    this.operation = operation;
    this.retryable = options?.retryable ?? false;
  }
}
