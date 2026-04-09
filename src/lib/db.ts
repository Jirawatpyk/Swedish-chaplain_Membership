import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from './env';
import * as schema from '@/modules/auth/infrastructure/db/schema';

/**
 * Drizzle client singleton (T025, plan.md § Constraints).
 *
 * Constraints:
 *   - 5-second statement timeout (Postgres `statement_timeout`)
 *   - 3-second connection acquisition timeout
 *   - SSL required (Neon)
 *
 * The HMR cache below prevents Next.js dev mode from creating a new
 * connection pool on every file change — without it the Neon project
 * runs out of connections within minutes.
 */

declare global {
  var __dbClient: ReturnType<typeof postgres> | undefined;
}

function createPgClient() {
  return postgres(env.database.url, {
    max: env.isProduction ? 10 : 2,
    idle_timeout: 20,
    connect_timeout: 3,
    // Apply statement timeout per-connection (5 seconds, milliseconds)
    connection: {
      // postgres.js maps `connection` keys to runtime parameters; statement_timeout
      // is a numeric (ms) parameter that postgres.js accepts as a string per its
      // type definitions.
      statement_timeout: 5_000,
    } as Record<string, string | number>,
    // Neon requires TLS — postgres.js auto-detects from the URL but be explicit.
    ssl: 'require',
    // Reduce noise in dev: pino owns logging
    onnotice: () => {},
  });
}

const pgClient = global.__dbClient ?? createPgClient();
if (!env.isProduction) {
  global.__dbClient = pgClient;
}

export const db = drizzle(pgClient, { schema });

export type Database = typeof db;
