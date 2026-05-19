/**
 * F2 — server-only sub-barrel.
 *
 * Round 6 W-008 — separate from `index.ts` (the public Domain +
 * Application barrel) to expose Drizzle-backed Infrastructure
 * adapters WITHOUT pulling them into client bundles.
 *
 * Usage rule: ONLY server-side composition roots may import from
 * `@/modules/plans/server` (renewals-deps, broadcast-deps, F4
 * deps, route handlers, server actions). Client components MUST
 * stick to `@/modules/plans` for type-only / Domain imports.
 *
 * Why a separate file (not just an `export from` in `index.ts`):
 * the public barrel is reachable from client components via
 * type-only imports of Domain types. Webpack/Turbopack would tree-
 * shake the unused server symbols out, BUT `postgres` (postgres-js)
 * has top-level side-effect imports (`fs` for SSL cert reads) that
 * survive tree-shaking when the barrel pulls them transitively.
 * Sub-barrel isolation pattern matches F4's `invoicing/server.ts`
 * convention (informal across modules; this is the first F2 instance).
 *
 * Constitution Principle III boundary still applies — cross-module
 * imports MUST use either `@/modules/plans` (Domain/Application) or
 * `@/modules/plans/server` (Infrastructure adapters), NEVER deep
 * paths into `./infrastructure/db/...`.
 */
export { drizzleScheduledPlanChangeRepo } from './infrastructure/db/drizzle-scheduled-plan-change-repo';

// Post-ship R6 I2 / D2 (2026-05-19) — F8 cross-module audit emit.
// F8's `accept-tier-upgrade` use-case calls
// `supersedeAndInsertPendingAtomically` directly (not via the F2 use-
// case). To keep the F2-domain `plan_change_scheduled` audit trail
// alive when that path runs, F8 imports F2's audit adapter via this
// sub-barrel and emits post-tx. Constitution Principle III honoured:
// composition roots wire the port; F8 Application sees only
// `AuditPort` (type imported via `@/modules/plans` public barrel),
// not the concrete adapter file.
export { planAuditAdapter } from './infrastructure/audit/plan-audit-adapter';
