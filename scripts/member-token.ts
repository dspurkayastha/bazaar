/**
 * pnpm member:token <memberId>      issue a new API token for a member, revoking their previous ones (rotation)
 * pnpm member:token --list          list members and whether each has a live token
 *
 * Postgres only (DATABASE_URL). The plaintext `mtk_...` token is printed once; only its sha256 is stored.
 * Give it to the member's device (Siri shortcut, app) as `Authorization: Bearer mtk_...`.
 */
import 'dotenv/config';
import { and, eq, isNull } from 'drizzle-orm';
import { hashMemberToken, newMemberToken } from '../src/core/credentials.js';
import { createDb } from '../src/db/client.js';
import { rotateMemberCredential } from '../src/db/credentials.js';
import { memberCredentials, members } from '../src/db/schema.js';

const arg = process.argv[2];
const { db, close } = createDb();

try {
  if (!arg || arg === '--list') {
    const rows = await db
      .select({ id: members.id, name: members.name, role: members.role, live: memberCredentials.id })
      .from(members)
      .leftJoin(
        memberCredentials,
        and(eq(memberCredentials.memberId, members.id), isNull(memberCredentials.revokedAt)),
      );
    for (const r of rows) console.log(`${r.id}  ${r.name} (${r.role})  ${r.live ? 'token issued' : 'no token'}`);
    if (!arg) console.log('\nusage: pnpm member:token <memberId>');
  } else {
    const [m] = await db.select().from(members).where(eq(members.id, arg));
    if (!m) throw new Error(`no member ${arg}`);
    const token = newMemberToken();
    await rotateMemberCredential(db, m.id, hashMemberToken(token));
    console.log(`New token for ${m.name} (${m.role}); previous tokens are revoked. Shown once:\n\n  ${token}\n`);
  }
} finally {
  await close();
}
