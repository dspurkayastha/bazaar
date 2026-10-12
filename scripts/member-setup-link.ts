/**
 * pnpm member:setup-link <memberKeyOrId>   print a one-time passkey setup link for a member (48 h, single use)
 * pnpm member:setup-link                   list members and whether each has a passkey
 *
 * The owner's way in from the VPS shell, before any passkey exists (afterwards: Household → Members in the web app).
 * <memberKeyOrId> is the member id (mem_...) or the member's name, case-insensitive ("dev").
 * Postgres only (DATABASE_URL). The link uses WEB_ORIGIN; open it on the phone that will hold the passkey. Creating a
 * link revokes that member's earlier unused links. Only the code's sha256 is stored.
 */
import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { webConfigFromEnv } from '../src/api/web-config.js';
import { createSetupLink } from '../src/auth/session.js';
import { createDb } from '../src/db/client.js';
import { members, webauthnCredentials } from '../src/db/schema.js';
import { DbStore } from '../src/db/store.js';

const arg = process.argv[2]?.trim();
const { db, close } = createDb();

try {
  if (!arg) {
    const rows = await db
      .select({
        id: members.id,
        name: members.name,
        role: members.role,
        passkeys: sql<number>`count(${webauthnCredentials.id})`.mapWith(Number),
      })
      .from(members)
      .leftJoin(webauthnCredentials, eq(webauthnCredentials.memberId, members.id))
      .groupBy(members.id);
    for (const r of rows)
      console.log(`${r.id}  ${r.name} (${r.role})  ${r.passkeys > 0 ? 'has a passkey' : 'no passkey'}`);
    console.log('\nusage: pnpm member:setup-link <memberId | name>');
  } else {
    const byId = await db.select().from(members).where(eq(members.id, arg));
    const found =
      byId.length > 0
        ? byId
        : await db
            .select()
            .from(members)
            .where(sql`lower(${members.name}) = ${arg.toLowerCase()}`);
    if (found.length === 0) throw new Error(`no member "${arg}" (run without arguments to list members)`);
    if (found.length > 1)
      throw new Error(
        `"${arg}" matches ${found.length} members; use the id:\n${found.map((m) => `  ${m.id} ${m.name}`).join('\n')}`,
      );
    const m = found[0]!;
    const web = webConfigFromEnv();
    const link = await createSetupLink(new DbStore(db), {
      memberId: m.id,
      householdId: m.householdId,
      origin: web.origin,
      now: new Date().toISOString(),
    });
    console.log(
      `Passkey setup link for ${m.name} (${m.role}). Single use, expires ${link.expiresAt}:\n\n  ${link.url}\n`,
    );
    console.log(`Open it on the phone that will hold the passkey (RP id ${web.rpId}).`);
  }
} finally {
  await close();
}
