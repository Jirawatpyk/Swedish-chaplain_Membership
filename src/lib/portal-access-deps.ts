/**
 * 059-membership-suspension Task 7 — production composition for
 * `checkPortalAccess` (Task 3, `src/lib/lapsed-portal-scope.ts`).
 *
 * Shared by both presentation chokepoints:
 *   - `requireMemberContext` (`src/lib/member-context.ts`) — the ALWAYS-ON
 *     API-layer gate. Every `/api/portal/**` route that resolves its member
 *     via `requireMemberContext` gets `checkPortalAccess` enforcement on
 *     every request, regardless of how the client navigated there.
 *   - `enforcePortalPageAccess` (`src/lib/portal-page-access.ts`) — SSR-load
 *     defense-in-depth for `/portal/**` pages. Next.js 16 layouts do NOT
 *     re-run on client-side navigation between sibling routes, so this
 *     guard only fires on SSR load / hard refresh / direct navigation — it
 *     is NOT a substitute for the API-layer gate above.
 *
 * Wiring mirrors the escape-hatch pattern already used by the F3/F7
 * `membershipAccessBridge` adapters (`src/modules/members/infrastructure/
 * membership-access-bridge.ts`, `src/modules/broadcasts/infrastructure/
 * membership-access-bridge.ts`): `makeDrizzleRenewalCycleRepo` /
 * `makeDrizzleRenewalAuditEmitter` are imported directly rather than
 * routed through F8's full `makeRenewalsDeps()` — that eagerly wires ~20
 * adapters (email gateway, at-risk scorer, tier-upgrade repos, …) this gate
 * needs none of. `src/lib/**` is exempt from the cross-module public-barrel
 * ESLint rule (see `eslint.config.mjs` — it is the composition-adapter
 * layer between Presentation and Module internals), so the deep
 * infrastructure import is allowed here, same as the two bridge adapters.
 *
 * Clock: `checkPortalAccess` → `deriveMembershipAccess` needs an injected
 * `now: Date`. Uses invoicing's `systemClock` (`ClockPort.nowIso()` returns
 * an ISO string) wrapped in `new Date(...)` — the same zero-import leaf
 * clock source the bridge adapters use.
 */
import { systemClock } from '@/modules/invoicing/application/ports/clock-port';
import { makeDrizzleRenewalCycleRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo';
import { makeDrizzleRenewalAuditEmitter } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter';
import type { TenantContext } from '@/modules/tenants';
import type { PortalAccessContext, PortalAccessDeps } from './lapsed-portal-scope';

export function buildPortalAccessDeps(tenant: TenantContext): PortalAccessDeps {
  return {
    cyclesRepo: makeDrizzleRenewalCycleRepo(tenant),
    auditEmitter: makeDrizzleRenewalAuditEmitter(tenant),
    clock: { now: () => new Date(systemClock.nowIso()) },
  };
}

const PORTAL_ACCESS_HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

/**
 * Narrows a raw `request.method` string to the closed HTTP-method union
 * `PortalAccessContext['action']` expects. An unrecognised/typo'd verb
 * degrades to `undefined` (→ a `null` audit-row field) instead of a type
 * error or a silently-wrong cast.
 */
export function toPortalAccessAction(method: string): PortalAccessContext['action'] {
  return PORTAL_ACCESS_HTTP_METHODS.has(method)
    ? (method as PortalAccessContext['action'])
    : undefined;
}
