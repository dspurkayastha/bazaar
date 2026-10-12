/**
 * Gate serialisation (review 5a / 5c). Two gate runs for the same household must never interleave between
 * "read spend" and "record the placed order", or both can pass a cap that only one of them fits under, and two
 * approvals of one quote can both reach checkout.
 *
 * `GateLock.run(householdId, critical)` runs `critical` while holding the household's lock. The gate does all of
 * its work inside: idempotency check, live-cart read, spend re-read (via the context builder), decide, record,
 * place, record placed.
 *
 * Implementations:
 *  - MemoryGateLock: in-process single flight, a promise chain keyed by householdId. Enough for one process.
 *  - PgGateLock (src/db/lock.ts): the same in-process chain, then pg_advisory_xact_lock(hashtext(householdId))
 *    inside a transaction that the DB store and recorder use for every read and write in the critical section.
 *
 * `critical` should not throw for expected outcomes (HOLD/BLOCK): a database implementation rolls back on throw.
 * The gate returns a result object from inside the lock and throws after it is released.
 */
export interface GateLock {
  run<T>(householdId: string, critical: () => Promise<T>): Promise<T>;
}

export class MemoryGateLock implements GateLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(householdId: string, critical: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(householdId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    // `previous` only ever resolves (it is a chain of release promises), so the chain cannot break.
    const tail = previous.then(() => mine);
    this.tails.set(householdId, tail);
    await previous;
    try {
      return await critical();
    } finally {
      release();
      if (this.tails.get(householdId) === tail) this.tails.delete(householdId);
    }
  }

  /** Households with a gate run in progress or queued (for tests and diagnostics). */
  get busy(): number {
    return this.tails.size;
  }
}

/**
 * The process-wide lock used when a caller does not pass one. Shared on purpose: two callers that forget to pass a
 * lock still serialise against each other.
 */
export const processGateLock: GateLock = new MemoryGateLock();
