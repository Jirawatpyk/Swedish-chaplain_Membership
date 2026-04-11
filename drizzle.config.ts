import { defineConfig } from 'drizzle-kit';

// Load .env.local before reading process.env (Node 20.12+ built-in,
// no dotenv dependency). drizzle-kit does NOT auto-load .env files.
process.loadEnvFile?.('.env.local');

/**
 * Drizzle Kit configuration.
 *
 * Uses DATABASE_URL_UNPOOLED for migrations (pooled connections can
 * interfere with schema migrations on Neon). The app runtime uses the
 * pooled DATABASE_URL via `src/lib/db.ts`.
 */
const connectionString =
  process.env.DATABASE_URL_UNPOOLED ??
  process.env.POSTGRES_URL_NON_POOLING ??
  process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'drizzle.config.ts: no connection string found. Set DATABASE_URL_UNPOOLED or DATABASE_URL in .env.local.',
  );
}

export default defineConfig({
  schema: [
    './src/modules/auth/infrastructure/db/schema.ts',
    // F2: plans + fee config schema (002-membership-plans)
    './src/modules/plans/infrastructure/db/schema.ts',
  ],
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: connectionString,
  },
  verbose: true,
  strict: true,
  migrations: {
    table: 'drizzle_migrations',
    schema: 'public',
  },
});
