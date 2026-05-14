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
import { eventcreateMetrics } from '@/lib/metrics';
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
import { archiveEvent } from '@/modules/events/application/use-cases/archive-event';
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
import type {
  ArchiveEventInput,
  ArchiveEventOutput,
  ArchiveEventError,
} from '@/modules/events/application/use-cases/archive-event';
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
 * Internal rollback signal — thrown inside `runInTenant` to force
 * Postgres to roll back the open transaction when a use-case returns
 * `Result.err`. The outer catch unwraps the signal back into the
 * canonical `Result.err` shape so callers continue to type-check
 * against the use-case's documented error union.
 *
 * Why this exists (wave-5 cross-check finding CRIT-1): `runInTenant`
 * is plain `db.transaction(fn)`. Postgres only rolls back when the
 * callback **throws** — a resolved `Result.err` value is treated as
 * success by the DB driver and the tx COMMITS. Before this signal,
 * `toggle-event-category` / `archive-event` could leave partial state
 * (e.g., event flag flipped + half the registrations credit-backed)
 * if a later step in the use-case loop returned `err`. The signal +
 * outer catch closes the FR-037 strict-tx ACID invariant for admin
 * write paths. The ingest path uses the same conceptual pattern via
 * `TxStageError` thrown from inside the use-case body.
 *
 * Internal to this file — NOT exported. Callers see a normal `Result`.
 */
class TxRollbackSignal<E> extends Error {
  constructor(readonly resultError: E) {
    super('runInTenant rollback signal — Result.err propagation');
    this.name = 'TxRollbackSignal';
  }
}

/**
 * Wraps `runInTenant` so a `Result.err` return from the use-case
 * triggers Postgres ROLLBACK (by throwing internally), then unwraps
 * the signal back into `Result.err` for the caller. Any non-signal
 * throw from `runInTenant` (DB connection drop, RLS assertion, etc.)
 * is re-thrown so the route's catch handler maps it to 500.
 */
async function runInTenantWithRollbackOnErr<T, E>(
  ctx: ReturnType<typeof asTenantContext>,
  fn: (tx: TenantTx) => Promise<Result<T, E>>,
): Promise<Result<T, E>> {
  try {
    return await runInTenant(ctx, async (tx) => {
      const result = await fn(tx);
      if (!result.ok) {
        throw new TxRollbackSignal<E>(result.error);
      }
      return result;
    });
  } catch (e) {
    if (e instanceof TxRollbackSignal) {
      return { ok: false, error: e.resultError as E };
    }
    throw e;
  }
}

/**
 * Convenience for the toggle-{partner-benefit,cultural-event} route
 * handlers. Wraps `runInTenant` + deps composition so the route is a
 * thin parser-and-dispatch shell.
 *
 * NOTE (wave-5 CRIT-1 fix): uses `runInTenantWithRollbackOnErr` so
 * partial state from a mid-loop failure (e.g., audit emit fails after
 * the event flag flipped) ROLLS BACK instead of committing.
 */
export async function runToggleEventCategory(
  tenantSlug: string,
  input: Omit<ToggleEventCategoryInput, 'tenantId'>,
): Promise<Result<ToggleEventCategoryOutput, ToggleEventCategoryError>> {
  const ctx = asTenantContext(tenantSlug);
  const tenantId: TenantId = asTenantId(tenantSlug);
  // R6 PERF-R6-05 closure (R7 ERR-FR-02 hardened) — record toggle
  // duration histogram for SLO-F6-007 monitoring. `performance.now()`
  // is the monotonic clock (Vercel Fluid Compute can NTP-adjust
  // `Date.now()` backwards mid-invocation, producing negative
  // latencies that some OTel SDKs drop as out-of-range and others
  // accept as artificially-low observations that skew p50 down).
  // `Math.max(0, ...)` is defense-in-depth in case `performance.now()`
  // also exhibits unexpected behavior in some runtime environments.
  // Fires on BOTH success and error paths so pool-pressure regressions
  // surface even when toggle returns err.
  const startedAt = performance.now();
  try {
    return await runInTenantWithRollbackOnErr(ctx, async (tx) => {
      const deps = makeToggleEventCategoryDeps(tx, ctx);
      return toggleEventCategory({ ...input, tenantId }, deps);
    });
  } finally {
    eventcreateMetrics.toggleDurationMs(
      tenantSlug,
      Math.max(0, performance.now() - startedAt),
    );
  }
}

/**
 * Phase 6 wave-4 — composes the archive-event deps bag.
 *
 * **Staff-review-4 SUGG-2 update**: archive NOW needs
 * `quotaAccountingPort` to compute actual `allotmentAfter` per
 * `quota_credit_back_archive` audit row (matching the refund credit-
 * back pattern at `ingest-webhook-attendee.ts:786`). The previous
 * design hardcoded `allotmentAfter: 0` as a sentinel, which forensic
 * dashboards filtering on `allotmentAfter > 0` would silently skip.
 * The macro `event_archived` audit still carries the aggregate
 * reversal count (`registrationsAffected`) — that remains the
 * authoritative dashboard number — but per-row credit-back audits
 * now mirror the refund path's forensic shape.
 */
export function makeArchiveEventDeps(
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
 * NOTE (wave-5 CRIT-1 fix): uses `runInTenantWithRollbackOnErr` so
 * if the archive credit-back loop fails mid-iteration after `setArchived`
 * already updated `events.archived_at`, the entire archive ROLLS BACK
 * — preserving FR-037 strict-tx ACID. Without this wrapper a partial
 * archive would commit (event archived + only some registrations
 * credit-backed) and leave permanent drift in the quota counters.
 */
export async function runArchiveEvent(
  tenantSlug: string,
  input: Omit<ArchiveEventInput, 'tenantId'>,
): Promise<Result<ArchiveEventOutput, ArchiveEventError>> {
  const ctx = asTenantContext(tenantSlug);
  const tenantId: TenantId = asTenantId(tenantSlug);
  // R6 PERF-R6-05 closure (R7 ERR-FR-02 hardened) — record archive
  // duration histogram for SLO-F6-007 monitoring (target: p95 < 5s @
  // N=50 / < 12s @ N=200). Uses monotonic `performance.now()` instead
  // of wall-clock `Date.now()` to avoid NTP-induced negative latencies.
  // See toggle wrapper above for rationale.
  const startedAt = performance.now();
  try {
    return await runInTenantWithRollbackOnErr(ctx, async (tx) => {
      const deps = makeArchiveEventDeps(tx, ctx);
      return archiveEvent({ ...input, tenantId }, deps);
    });
  } finally {
    eventcreateMetrics.archiveDurationMs(
      tenantSlug,
      Math.max(0, performance.now() - startedAt),
    );
  }
}
