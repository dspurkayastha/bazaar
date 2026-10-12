/** Member credential rows (sha256 of `mtk_...` tokens). Shared by DbStore, the seed and `pnpm member:token`. */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { newId } from '../core/ids.js';
import type { Db } from './client.js';
import type { Tx } from './lock.js';
import { memberCredentials } from './schema.js';

/** Revoke the member's live credentials and install `tokenHash` as the only live one, atomically. */
export async function rotateMemberCredential(db: Db | Tx, memberId: string, tokenHash: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(memberCredentials)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(memberCredentials.memberId, memberId), isNull(memberCredentials.revokedAt)));
    await tx.insert(memberCredentials).values({ id: newId('mc'), memberId, tokenHash });
  });
}
