import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { env } from './env';
import type { TenantContext } from '@/modules/tenants';
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

// ---------------------------------------------------------------------------
// F2 — Tenant-scoped transaction helper (`runInTenant`)
//
// Every tenant-scoped query path MUST go through `runInTenant(ctx, fn)`.
// This helper opens an explicit Drizzle transaction and, inside it,
// issues two `SET LOCAL` statements before the callback runs:
//
//   1. `SET LOCAL ROLE chamber_app` — switches the transaction's
//      effective role to a `NOBYPASSRLS` role. Neon's default integration
//      role (`neondb_owner`) has `rolbypassrls = TRUE`, which silently
//      disables `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`
//      for queries run as the owner. Without this `SET LOCAL ROLE` the
//      RLS policies are a no-op. See research.md § 2.4 "CRITICAL FINDING".
//
//   2. `SET LOCAL app.current_tenant = <slug>` — sets the per-transaction
//      session variable that every tenant-isolation policy reads from
//      `current_setting('app.current_tenant', TRUE)`. `SET LOCAL` scopes
//      the value to the current transaction so pgBouncer transaction-mode
//      pooling doesn't leak it between requests.
//
// Both are `SET LOCAL` (never session-level `SET`) because transaction
// scoping is the only way pgBouncer can safely reuse a backend
// connection for a different tenant's next request.
//
// The `DEBUG_RLS_STATE=true` dev-mode assertion verifies, at the END of
// every `runInTenant` transaction, that `current_user = 'chamber_app'`
// AND `current_setting('app.current_tenant', TRUE) = ctx.slug`. Either
// mismatch is a loud developer-facing error — prevents "I forgot
// runInTenant" and "I forgot SET LOCAL ROLE" bug classes.
// ---------------------------------------------------------------------------

const DEBUG_RLS_STATE = env.tenant.debugRlsState;

export class TenantContextAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextAssertionError';
  }
}

export type TenantTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run `fn` inside a Drizzle transaction that has been hardened against
 * cross-tenant leakage:
 *
 *   BEGIN;
 *     SET LOCAL ROLE chamber_app;
 *     SET LOCAL app.current_tenant = '<ctx.slug>';
 *     -- fn(tx) runs here
 *   COMMIT;
 *
 * Usage (from infrastructure repos):
 *
 *   import { runInTenant } from '@/lib/db';
 *   import { membershipPlans } from './schema';
 *
 *   export const planRepo = {
 *     findByTenantAndYear: (ctx, year) =>
 *       runInTenant(ctx, (tx) =>
 *         tx.select().from(membershipPlans).where(eq(membershipPlans.planYear, year))
 *       ),
 *   };
 *
 * Note: do NOT add an explicit `WHERE tenant_id = ctx.slug` — the RLS
 * policy adds it automatically, and an explicit filter would be a code
 * smell implying distrust of the RLS layer.
 */
export async function runInTenant<T>(
  ctx: TenantContext,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Order matters: switch role first so the subsequent GUC write is
    // logged against the chamber_app role. Both statements are parameter-
    // safe — ctx.slug is already validated by asTenantContext against
    // `[a-z0-9-]{1,63}` so there is no injection surface even though GUC
    // names don't accept bind parameters. The runtime assertion below is
    // a belt-and-suspenders guard against future type-system bypasses.
    if (!/^[a-z0-9-]{1,63}$/.test(ctx.slug)) {
      throw new Error(`runInTenant: slug invariant violated: ${ctx.slug}`);
    }
    await tx.execute(sql`SET LOCAL ROLE chamber_app`);
    await tx.execute(sql.raw(`SET LOCAL app.current_tenant = '${ctx.slug}'`));

    const result = await fn(tx);

    if (DEBUG_RLS_STATE) {
      await assertTenantContextSet(tx, ctx);
    }

    return result;
  });
}

/**
 * Dev-mode assertion: verify the current transaction is running as
 * `chamber_app` AND has `app.current_tenant` set to the expected slug.
 *
 * Only fires when `DEBUG_RLS_STATE=true` is set in `.env.local`
 * (production is blocked from setting this flag by `src/lib/env.ts`).
 * In production the secure-by-default RLS behaviour handles the "forgot
 * to set tenant" case silently — here we trade speed for loud feedback.
 *
 * Exported so tests (`rls-debug-state.test.ts`) can exercise it directly.
 */
export async function assertTenantContextSet(
  tx: TenantTx,
  expected?: TenantContext,
): Promise<void> {
  if (!DEBUG_RLS_STATE) return;

  const rows = (await tx.execute(
    sql`SELECT current_user AS u, current_setting('app.current_tenant', TRUE) AS t`,
  )) as unknown as Array<{ u: string; t: string | null }>;

  const row = rows[0];
  if (!row) {
    throw new TenantContextAssertionError(
      '[DEBUG_RLS_STATE] Could not introspect transaction state — empty result from `SELECT current_user, current_setting(...)`.',
    );
  }

  if (row.u !== 'chamber_app') {
    throw new TenantContextAssertionError(
      `[DEBUG_RLS_STATE] Transaction is running as "${row.u}", expected "chamber_app". ` +
        'This means `SET LOCAL ROLE chamber_app` was not issued — RLS is being bypassed by the BYPASSRLS owner role. ' +
        'Wrap the query in `runInTenant(ctx, ...)` from `@/lib/db`. ' +
        'See specs/002-membership-plans/research.md § 2.4 CRITICAL FINDING.',
    );
  }

  if (row.t === null || row.t === '') {
    throw new TenantContextAssertionError(
      '[DEBUG_RLS_STATE] Query ran without `app.current_tenant` set. ' +
        'Wrap the query in `runInTenant(ctx, ...)` from `@/lib/db`. ' +
        'See specs/002-membership-plans/research.md § 2.5.',
    );
  }

  if (expected && row.t !== expected.slug) {
    throw new TenantContextAssertionError(
      `[DEBUG_RLS_STATE] Tenant mismatch: session variable is "${row.t}" but expected "${expected.slug}". ` +
        'This usually means a runInTenant nested inside another runInTenant for a different tenant, which is never legal.',
    );
  }
}
