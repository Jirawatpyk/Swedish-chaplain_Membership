import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { env } from './env';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
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
    // Pool size:
    //   prod : 10 — Vercel function instances are short-lived; 10 keeps
    //          headroom for concurrent webhook bursts.
    //   dev  : 8  — Stripe CLI forwards 3-4 webhooks per payment in
    //          quick succession (payment_intent.created → succeeded
    //          → charge.succeeded → charge.updated). Some dispatches
    //          (`confirmPayment`) make 2-3 separate DB calls that
    //          each acquire a connection (own withTx + F4 bridge calls
    //          via the global `db` instance). Pool size 2 caused
    //          connection-queue deadlocks — handlers waited 30 s for
    //          a connection that another concurrent handler held →
    //          Stripe CLI timed out → user saw "stuck on payment form"
    //          (audit 2026-04-25 follow-up).
    //
    // `DATABASE_POOL_MAX` env var overrides both defaults so Vercel
    // can tune for sustained webhook bursts without a code change.
    max: env.database.poolMax ?? (env.isProduction ? 10 : 8),
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
 * Phase 3F.11.14 (TxToken Step 4) — centralised unbrand helper. Used
 * by infrastructure adapters that receive a `TxToken`-typed parameter
 * (per the F71A port contracts at `@/modules/broadcasts/application/
 * ports/advisory-lock-port.ts`) and need the raw Drizzle `TenantTx`
 * to call `tx.execute(...)`. The unbrand is structural (TxToken is a
 * compile-time brand wrapped over the runtime Drizzle tx shape), so
 * the double cast `as unknown as TenantTx` is the unavoidable TS
 * mechanism — this helper centralises it in ONE file so future audits
 * see exactly one place where the brand barrier is crossed.
 *
 * Generic-typed input so any adapter-internal `TxToken | unknown`
 * shape can satisfy it without callers needing to know the brand
 * mechanism.
 */
export function unbrandTx(token: unknown): TenantTx {
  return token as unknown as TenantTx;
}

/**
 * Tx parameter type for bare `db.transaction(...)` callbacks (i.e.
 * cross-tenant flows that do NOT go through `runInTenant`). Structurally
 * identical to `TenantTx` — Drizzle's tx shape is the same either way.
 * Exported as a distinct alias for semantic clarity: callers who use
 * `DbTx` announce they intentionally operate outside a tenant
 * `runInTenant` chain because they need owner-role privileges on
 * cross-tenant identity tables (e.g. F1 invitation flow — `users` and
 * `invitations` have no INSERT grant for `chamber_app`). Post-Round-3
 * Option G the rows written here still carry a tenant_id when their
 * target table requires one (e.g. `notifications_outbox.tenant_id`
 * is NOT NULL since migration 0098).
 */
export type DbTx = TenantTx;

/**
 * Round 2 review-fix (I-2) / Round 3 review-fix (R3-S5): runtime
 * **method-presence check** for a Drizzle tx handle.
 *
 * **Important — this is NOT a tenant-scope check.** The guard verifies
 * only that the value exposes Drizzle's tx-callback method shape
 * (`execute`, `select`, `insert`, `update`, `delete`, `transaction` as
 * functions). It does NOT verify that:
 *   - the tx has `SET LOCAL ROLE chamber_app` applied (Constitution
 *     Principle I sub-clause 1+2)
 *   - the tx has `SET LOCAL app.current_tenant = <slug>` applied
 *   - the tx's tenant scope matches the caller's expected tenant
 *
 * Use this only for **defending against F4 contract drift** in the
 * F4 → F8 onPaidCallback path: F4 opens its tx via its own `withTx →
 * runInTenant` chain BEFORE invoking the callback, so by the time the
 * callback runs the tx IS tenant-scoped. The guard catches the case
 * where a future refactor wraps `tx` in instrumentation, forgets to
 * thread it, or passes a non-tx value (event payload, sentinel) by
 * accident — all of which would explode as `TypeError: tx.execute is
 * not a function` deep in a query callsite without this check.
 *
 * **Future relocation note** (`/speckit.staff-review.run` Wave K23
 * R006 — non-blocking suggestion): if F5 / F6 / F7 cross-module
 * callbacks proliferate post-MVP and each adopts this duck-type
 * pattern, consider relocating `isTenantTx` to `@/modules/tenants`
 * (it is conceptually a tenant-isolation primitive, not a DB
 * primitive). Current placement at `@/lib/db` is defensible because
 * the only consumer today is F4 → F8 and the `TenantTx` type itself
 * is owned by `@/lib/db`. F9 cross-cutting cleanup can revisit.
 *
 * For ANY new cross-module callback wiring, either:
 *   (a) trust the upstream `runInTenant` chain (current F4 → F8 path)
 *       and use this guard as belt-and-braces, OR
 *   (b) call `assertTenantContextSet(tx, expectedCtx)` to verify the
 *       runtime tenant scope AND the role.
 *
 * False-positives on the method-presence check require intentional
 * spoofing (a foreign object that mimics all 6 method names as
 * functions); none of F4's call paths can produce such a value.
 *
 * Usage:
 *
 *   const txMaybe: unknown = …;
 *   if (!isTenantTx(txMaybe)) {
 *     // Log + fall back to a fresh runInTenant — never silently cast.
 *     return runInTenant(ctx, body);
 *   }
 *   return body(txMaybe);
 */
const TX_DUCK_METHODS = [
  'execute',
  'select',
  'insert',
  'update',
  'delete',
  'transaction',
] as const;
export function isTenantTx(value: unknown): value is TenantTx {
  if (value === null || typeof value !== 'object') return false;
  for (const method of TX_DUCK_METHODS) {
    if (typeof (value as Record<string, unknown>)[method] !== 'function') {
      return false;
    }
  }
  return true;
}

/**
 * Run `fn` inside a Drizzle transaction that has been hardened against
 * cross-tenant leakage:
 *
 *   BEGIN;
 *     SET LOCAL row_security = on;
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
    // ctx.slug is already validated by asTenantContext against
    // `[a-z0-9-]{1,63}` so there is no injection surface even though GUC
    // names don't accept bind parameters. The runtime check below is a
    // belt-and-suspenders guard against future type-system bypasses.
    if (!/^[a-z0-9-]{1,63}$/.test(ctx.slug)) {
      throw new Error(`runInTenant: slug invariant violated: ${ctx.slug}`);
    }
    // RLS hardening (incident 2026-07-17): force `row_security = on` for
    // this transaction FIRST. A pooled Neon connection can inherit a stale
    // session-level `row_security = off` (e.g. an owner-level `SET
    // row_security = off` left on the shared transaction-mode pooler by an
    // ops script). Because the connection role is BYPASSRLS, the `SET LOCAL
    // ROLE chamber_app` below drops to a NOBYPASSRLS role — and with
    // row_security=off every FORCE-RLS tenant read then raises SQLSTATE
    // 42501 ("query would be affected by row-level security policy"): an
    // intermittent, hard-to-trace failure. `SET LOCAL` scopes it to this tx
    // (auto-reset at COMMIT), so runInTenant self-heals a contaminated
    // connection and RLS is always ENFORCED — never errored, never bypassed.
    // Role is switched next, BEFORE the app.current_tenant GUC write, so the
    // GUC is logged against chamber_app. See
    // docs/runbooks/rls-row-security-incident.md.
    await tx.execute(sql`SET LOCAL row_security = on`);
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
 * Convenience: run `fn` inside the caller's tx if provided, OR open a
 * fresh `runInTenant` scope when tx is null/undefined. Centralises the
 * conditional that repo adapters use when the same method serves both
 * "caller controls the tx" (use-case threading per Constitution
 * Principle I sub-clause 3 — atomic mutation+audit) and "open my own
 * tx" (standalone read or external-caller) call shapes.
 *
 * Lifted to `@/lib/db` 2026-05-21 closing review finding simplifier H4:
 * was byte-identical between
 * `drizzle-image-allowlist-repo.ts:52-64` + `drizzle-broadcast-templates-repo.ts:57-69`.
 * Two further F4/F5 patterns benefit from this same centralisation but
 * are not in F7.1a scope to refactor.
 *
 * `tenantSlug` is `TenantSlug` (not `string`) so callers cannot pass a
 * raw unbranded string — they MUST go through `asTenantContext` first.
 * M5 Round 2 closure 2026-05-21 — closes the `as unknown as string`
 * smell at the 2 adapter call sites.
 *
 * `tx` remains `unknown` because the codebase has heterogeneous brand
 * shapes (`BroadcastTemplatesTx` is a unique-symbol-tagged object,
 * `ImageAllowlistTx = unknown` is a pre-Phase-4 placeholder, future
 * F4/F5/F8 tx brands may use different shapes). Tightening to a union
 * would couple this lib to broadcasts brands (Constitution III barrel
 * violation); generic `<TBrand extends object>` excludes the legacy
 * `unknown`-typed ImageAllowlistTx. The brand discipline lives at the
 * thin local aliases in each adapter (e.g.
 * `drizzle-broadcast-templates-repo.ts:55-61`) where the wrapper
 * narrows the parameter to the port-specific brand BEFORE delegating
 * here. Net: `tx: unknown` at the lib boundary is acceptable because
 * the type discipline is enforced one layer up. Promoting ImageAllowlistTx
 * to a proper brand is F7.1b scope (post the Phase 4 ordering fix).
 *
 * The runtime check (`tx === null/undefined`) is the load-bearing
 * discriminator; the cast inside the truthy branch crosses the brand
 * barrier once inside this helper, NOT N times at every caller.
 */
import type { TenantSlug } from '@/modules/tenants';

export async function withTenantTxOrOpen<T>(
  tenantSlug: TenantSlug,
  tx: unknown,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (tx !== null && tx !== undefined) {
    return fn(tx as TenantTx);
  }
  return runInTenant(asTenantContext(tenantSlug), async (innerTx) =>
    fn(innerTx),
  );
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
    sql`SELECT current_user AS u, current_setting('app.current_tenant', TRUE) AS t, current_setting('row_security') AS rs`,
  )) as unknown as Array<{ u: string; t: string | null; rs: string }>;

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

  if (row.rs !== 'on') {
    throw new TenantContextAssertionError(
      `[DEBUG_RLS_STATE] row_security is "${row.rs}", expected "on". ` +
        'The connection inherited a stale `row_security = off`, under which a ' +
        'FORCE-RLS read raises SQLSTATE 42501 (or, on a BYPASSRLS role, silently ' +
        'bypasses RLS). runInTenant forces it on via `SET LOCAL row_security = on` — ' +
        'see docs/runbooks/rls-row-security-incident.md.',
    );
  }

  if (expected && row.t !== expected.slug) {
    throw new TenantContextAssertionError(
      `[DEBUG_RLS_STATE] Tenant mismatch: session variable is "${row.t}" but expected "${expected.slug}". ` +
        'This usually means a runInTenant nested inside another runInTenant for a different tenant, which is never legal.',
    );
  }
}
