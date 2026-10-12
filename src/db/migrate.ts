import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

const { db, close } = createDb();
try {
  await migrate(db, { migrationsFolder });
  console.log('migrations applied');
} finally {
  await close();
}
