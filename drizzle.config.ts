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
    // F3: members + contacts schema (005-members-contacts)
    './src/modules/members/infrastructure/db/schema-members.ts',
    './src/modules/members/infrastructure/db/schema-contacts.ts',
    // F4: invoices + receipts + credit notes (007-invoices-receipts).
    // Staff-review R2 R022 (2026-04-28) — was missing here, causing
    // `drizzle-kit generate` to issue spurious DROP TABLE statements
    // for F4 tables it could not see.
    './src/modules/invoicing/infrastructure/db/schema-invoices.ts',
    './src/modules/invoicing/infrastructure/db/schema-invoice-lines.ts',
    './src/modules/invoicing/infrastructure/db/schema-credit-notes.ts',
    './src/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings.ts',
    './src/modules/invoicing/infrastructure/db/schema-tenant-document-sequences.ts',
    // F5: payments + refunds + processor events (009-online-payment).
    // Same R022 fix — drizzle-kit must see F5 tables to manage them.
    './src/modules/payments/infrastructure/schema.ts',
    // F7: broadcasts + deliveries + suppressions + segment defs (010-email-broadcast).
    // Same R022 discipline — keep drizzle-kit aware of every F-stack module.
    './src/modules/broadcasts/infrastructure/schema.ts',
  ],
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: connectionString,
  },
  verbose: true,
  strict: true,
  migrations: {
    // Canonical journal: matches `drizzle-orm/postgres-js/migrator`'s
    // default that `pnpm db:migrate` (scripts/run-migrations.ts) uses.
    // Previously pointed at `public.drizzle_migrations` (drizzle-kit
    // default) which created a SECOND journal table that was always
    // empty — `drizzle-kit migrate` would re-apply already-applied
    // migrations and crash on duplicate enum/table errors. Unified
    // 2026-05-01 so both tools see the same applied set.
    table: '__drizzle_migrations',
    schema: 'drizzle',
  },
});
