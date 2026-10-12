import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(url: string | undefined = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set (see .env.example)');
  const sql = postgres(url, { max: 5 });
  const db = drizzle(sql, { schema });
  return { db, close: () => sql.end() };
}
