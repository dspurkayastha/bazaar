/**
 * Postgres GateLock. Serialises gate runs per household across processes with a transaction-scoped advisory lock:
 *
 *   BEGIN; SELECT pg_advisory_xact_lock(hashtext(householdId)); <critical section>; COMMIT
 *
 * The transaction is published through AsyncLocalStorage (`currentTx`), and DbStore / DbDecisionRecorder run every
 * read and write on it while it is active: the spend re-read, the decision record and the placed-order record all
 * happen on the locked connection, so the next gate run for the household (which blocks on the advisory lock)
 * sees them committed. Doing the I/O on the lock's own connection also means waiters can never starve the holder
 * of pool connections.
 *
 * Within one process, gate runs first queue on an in-memory chain so at most one connection per household sits
 * waiting on the advisory lock.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { MemoryGateLock, type GateLock } from '../policy/lock.js';
import type { Db } from './client.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const txStorage = new AsyncLocalStorage<Tx>();

/** The gate lock's transaction when called from inside a gate critical section, else undefined. */
export function currentTx(): Tx | undefined {
  return txStorage.getStore();
}

/** The connection to use: the active gate transaction if any, else the pool. */
export function conn(db: Db): Db | Tx {
  return txStorage.getStore() ?? db;
}

export class PgGateLock implements GateLock {
  private readonly local = new MemoryGateLock();

  constructor(private readonly db: Db) {}

  run<T>(householdId: string, critical: () => Promise<T>): Promise<T> {
    return this.local.run(householdId, () =>
      this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${householdId}))`);
        return txStorage.run(tx, critical);
      }),
    );
  }
}
