/**
 * F6 admin-routes composition adapter (Phase 4).
 *
 * Principle III note: like `src/lib/events-webhook-deps.ts`, this file
 * lives in `src/lib/**` because lib/ is the project's composition root —
 * the only layer permitted to reach into a module's Infrastructure for
 * adapter wiring while keeping the route handler (Presentation) free of
 * Drizzle imports. F5's `src/lib/stripe-webhook-deps.ts` precedent.
 *
 * Exposes two factories:
 *
 * - `makeListEventsDeps(tenantSlug)`
 * - `makeLoadEventDetailDeps(tenantSlug)`
 *
 * Each composes a Drizzle-backed `EventsRepository` / `RegistrationsRepository`
 * bound to a `runInTenant`-managed transaction. The route handler invokes
 * the use-case INSIDE `runInTenant(ctx, async (tx) => ...)`, passing
 * `deps` whose repos are factories that accept the running tx.
 *
 * Public API design — route handler code:
 *
 * const result = await runListEvents(tenant, input);
 *
 * not:
 *
 * const deps = makeListEventsDeps(tenant);
 * const result = await runInTenant(ctx, (tx) =>
 * listEvents(deps.bindTx(tx), input)
 * );
 *
 * The thin `run*` wrappers below take care of `asTenantContext` +
 * `runInTenant` for the route, so the route remains a small parser-and-
 * dispatch function (FR-035 RBAC + 200/404/500 mapping only).
 */
import { asTenantContext } from '@/modules/tenants';
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantId, type TenantId } from '@/modules/members';
// `asTenantContext` already
// validates slug format (throws `InvalidTenantSlugError` on malformed
// input — see `src/modules/tenants/domain/tenant-context.ts`). So the
// downstream `asTenantId(tenantSlug)` rubber-stamp is safe BECAUSE
// the slug has been validated by `asTenantContext` above. Document
// the chain here rather than introduce a redundant tryTenantId
// validation — both helpers consume the same slug format.
import { listEvents } from '@/modules/events/application/use-cases/list-events';
import { loadEventDetail } from '@/modules/events/application/use-cases/load-event-detail';
import { toggleEventCategory } from '@/modules/events/application/use-cases/toggle-event-category';
import type {
  ListEventsInput,
  ListEventsOutput,
  ListEventsError,
} from '@/modules/events/application/use-cases/list-events';
import type {
  LoadEventDetailInput,
  LoadEventDetailOutput,
  LoadEventDetailError,
} from '@/modules/events/application/use-cases/load-event-detail';
import type {
  ToggleEventCategoryInput,
  ToggleEventCategoryOutput,
  ToggleEventCategoryError,
} from '@/modules/events/application/use-cases/toggle-event-category';
import { makeDrizzleEventsRepository } from '@/modules/events/infrastructure/drizzle-events-repository';
import { makeDrizzleRegistrationsRepository } from '@/modules/events/infrastructure/drizzle-registrations-repository';
import { makeDrizzleQuotaAccountingAdapter } from '@/modules/events/infrastructure/drizzle-quota-accounting-adapter';
import { makeDrizzleAdvisoryLockAcquirer } from '@/modules/events/infrastructure/drizzle-advisory-lock-acquirer';
import { makePinoAuditPort } from '@/modules/events/infrastructure/pino-audit-port';
import type { Result } from '@/lib/result';

/**
 * Internal helper — composes deps from a running tx. Exported for tests
 * that want to drive the use-case against an injected mock tx without
 * going through `runInTenant`.
 */
export function makeListEventsDeps(executor: TenantTx) {
  return { eventsRepo: makeDrizzleEventsRepository(executor) };
}

export function makeLoadEventDetailDeps(executor: TenantTx) {
  return {
    eventsRepo: makeDrizzleEventsRepository(executor),
    registrationsRepo: makeDrizzleRegistrationsRepository(executor),
  };
}

/**
 * Convenience: wraps `runInTenant` + `makeListEventsDeps` + `listEvents`
 * so route handlers reduce to a single call.
 */
export async function runListEvents(
  tenantSlug: string,
  input: Omit<ListEventsInput, 'tenantId'>,
): Promise<Result<ListEventsOutput, ListEventsError>> {
  const ctx = asTenantContext(tenantSlug);
  const tenantId: TenantId = asTenantId(tenantSlug);
  return runInTenant(ctx, async (tx) => {
    const deps = makeListEventsDeps(tx);
    return listEvents(deps, { ...input, tenantId });
  });
}

export async function runLoadEventDetail(
  tenantSlug: string,
  input: Omit<LoadEventDetailInput, 'tenantId'>,
): Promise<Result<LoadEventDetailOutput, LoadEventDetailError>> {
  const ctx = asTenantContext(tenantSlug);
  const tenantId: TenantId = asTenantId(tenantSlug);
  return runInTenant(ctx, async (tx) => {
    const deps = makeLoadEventDetailDeps(tx);
    return loadEventDetail(deps, { ...input, tenantId });
  });
}

/**
 * Phase 6 T088 — composes the full F6 quota-accounting deps bag for
 * the admin toggle routes. Bundles every port `toggleEventCategory`
 * consumes: events + registrations repos, the F2/F3 plan-and-member
 * read bridge (`drizzle-quota-accounting-adapter`), the
 * `pg_advisory_xact_lock` primitive, and the audit emitter — all
 * bound to the caller's tx.
 */
export function makeToggleEventCategoryDeps(
  executor: TenantTx,
  ctx: ReturnType<typeof asTenantContext>,
) {
  const registrationsRepo = makeDrizzleRegistrationsRepository(executor);
  return {
    eventsRepo: makeDrizzleEventsRepository(executor),
    registrationsRepo,
    quotaAccountingPort: makeDrizzleQuotaAccountingAdapter(
      executor,
      ctx,
      registrationsRepo,
    ),
    advisoryLockAcquirer: makeDrizzleAdvisoryLockAcquirer(executor),
    audit: makePinoAuditPort(executor),
  };
}

/**
 * Convenience for the toggle-{partner-benefit,cultural-event} route
 * handlers. Wraps `runInTenant` + deps composition so the route is a
 * thin parser-and-dispatch shell.
 */
export async function runToggleEventCategory(
  tenantSlug: string,
  input: Omit<ToggleEventCategoryInput, 'tenantId'>,
): Promise<Result<ToggleEventCategoryOutput, ToggleEventCategoryError>> {
  const ctx = asTenantContext(tenantSlug);
  const tenantId: TenantId = asTenantId(tenantSlug);
  return runInTenant(ctx, async (tx) => {
    const deps = makeToggleEventCategoryDeps(tx, ctx);
    return toggleEventCategory({ ...input, tenantId }, deps);
  });
}
