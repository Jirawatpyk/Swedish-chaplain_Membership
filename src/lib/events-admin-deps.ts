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
import { logger } from '@/lib/logger';
import {
  asTenantId,
  memberTinPresenceByIdsInTx,
  type TenantId,
} from '@/modules/members';
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
import { relinkRegistration } from '@/modules/events/application/use-cases/relink-registration';
import { eraseAttendeePii } from '@/modules/events/application/use-cases/erase-attendee-pii';
import { searchAttendeeRegistrationsByEmail } from '@/modules/events/application/use-cases/search-attendee-registrations-by-email';
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
import type {
  RelinkRegistrationInput,
  RelinkRegistrationOutput,
  RelinkRegistrationError,
} from '@/modules/events/application/use-cases/relink-registration';
import type {
  EraseAttendeePiiInput,
  EraseAttendeePiiOutput,
  EraseAttendeePiiError,
} from '@/modules/events/application/use-cases/erase-attendee-pii';
import type {
  SearchAttendeeRegistrationsByEmailOutput,
  SearchAttendeeRegistrationsByEmailError,
} from '@/modules/events/application/use-cases/search-attendee-registrations-by-email';
import {
  makeEventRegistrationLookupForTenant,
  makeEventDetailsBatchLookupForTenant,
  asRegistrationId,
  tryEventId,
  type EventId,
} from '@/modules/events';
import { makeDrizzleEventsRepository } from '@/modules/events/infrastructure/drizzle-events-repository';
import { makeDrizzleRegistrationsRepository } from '@/modules/events/infrastructure/drizzle-registrations-repository';
import { makeDrizzleQuotaAccountingAdapter } from '@/modules/events/infrastructure/drizzle-quota-accounting-adapter';
import { makeDrizzleAdvisoryLockAcquirer } from '@/modules/events/infrastructure/drizzle-advisory-lock-acquirer';
import { makeAuditPortForTenant as makePinoAuditPort } from '@/modules/events';
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
 * 054-event-fee-invoices Task 10 — resolve a registration id to its event id
 * under the caller's tenant RLS. Used by `/admin/invoices/new` to pre-fill
 * the event picker from a `?eventRegistrationId=` deep-link.
 *
 * Returns the `eventId` (so the client picker can fetch the attendee list)
 * or `null` when the registration does not exist in the tenant (RLS hides
 * cross-tenant rows — a null is a clean miss, the page just renders the
 * empty Event tab). Threads the `runInTenant` tx into the F6 lookup factory
 * so the read runs under `SET LOCAL app.current_tenant` (Principle I);
 * `asRegistrationId` validates the uuid shape before the SELECT.
 */
export async function runResolveRegistrationEventId(
  tenantSlug: string,
  registrationId: string,
): Promise<string | null> {
  const ctx = asTenantContext(tenantSlug);
  return runInTenant(ctx, async (tx) => {
    const lookup = makeEventRegistrationLookupForTenant(tx);
    const result = await lookup.findById(
      asTenantId(tenantSlug),
      asRegistrationId(registrationId),
    );
    if (!result.ok || result.value === null) return null;
    return String(result.value.eventId);
  });
}

/**
 * 054-event-fee-invoices Task 14 — resolve a batch of event ids to their
 * `{ name, startDateIso }` under the caller's tenant RLS. Used by the
 * `/admin/invoices` list to render the buyer-subtitle line (event name +
 * CE start date) on event-fee invoice rows.
 *
 * ONE query (single `WHERE tenant_id = ? AND event_id IN (...)` SELECT via
 * the F6 `findByIds` repo method) — no N+1. An empty `eventIds` returns an
 * empty map WITHOUT touching the DB (the repo short-circuits), so an
 * all-membership invoice page pays zero extra DB cost. Threads the
 * `runInTenant` tx into the F6 batch-lookup factory so the read runs under
 * `SET LOCAL app.current_tenant` (Principle I); cross-tenant ids are
 * invisible (absent from the returned map, never leaked). Malformed ids are
 * dropped via `tryEventId` (null → skipped) before the SELECT — the
 * enrichment must never throw, so a stray non-UUID id is silently ignored
 * rather than crashing the list render.
 *
 * `startDateIso` is the CE/UTC ISO instant (Buddhist Era is display-only —
 * storage + this view stay Gregorian; the caller renders the Bangkok-local
 * CE date via `bangkokLocalDate`).
 *
 * A repo error (DB blip / RLS drift) surfaces as an EMPTY map rather than a
 * throw: the subtitle is a non-critical enrichment, so the list page must
 * never 500 because the event-name lookup failed — event rows fall back to
 * the CE date (or null) in the page composition. The F6 repo already logs
 * the underlying failure.
 */
export async function runListEventNamesByIds(
  tenantSlug: string,
  eventIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, { name: string; startDateIso: string }>> {
  if (eventIds.length === 0) return new Map();
  const ctx = asTenantContext(tenantSlug);
  const tenantId: TenantId = asTenantId(tenantSlug);
  // Drop malformed / non-UUID ids defensively. `eventId`s come from the
  // F4 invoice rows (DB uuid column) so they are well-formed in practice,
  // but `tryEventId` keeps the enrichment crash-proof.
  const branded: EventId[] = [];
  for (const id of eventIds) {
    const e = tryEventId(id);
    if (e !== null) branded.push(e);
  }
  const out = new Map<string, { name: string; startDateIso: string }>();
  if (branded.length === 0) return out;
  return runInTenant(ctx, async (tx) => {
    const lookup = makeEventDetailsBatchLookupForTenant(tx);
    const result = await lookup.findByIds(tenantId, branded);
    if (!result.ok) return out;
    for (const [eventId, event] of result.value) {
      out.set(String(eventId), {
        name: event.name,
        startDateIso: event.startDate.toISOString(),
      });
    }
    return out;
  });
}

/**
 * 064 remediation B5 — resolve a batch of MATCHED member ids to "has a
 * non-blank tax id" under the caller's tenant RLS. Used by the F6 admin
 * event-detail route to enrich each registration with `buyerHasTin`
 * (server-truth TIN presence for the /admin/invoices/new attendee picker,
 * replacing the legacy "matched ⇒ has TIN" client guess).
 *
 * ONE query via the F3 barrel's `memberTinPresenceByIdsInTx` free function
 * (same composition posture as `runListEventNamesByIds` above). Only the
 * PRESENCE boolean crosses this seam — never the raw tax-id (PII).
 * Cross-tenant ids are RLS-hidden (absent from the map, never leaked).
 *
 * A repo error (DB blip / malformed id) surfaces as an EMPTY map rather
 * than a throw: the enrichment is non-critical — the picker falls back to
 * the legacy guess and the server-side issuance guards stay authoritative.
 */
export async function runListMemberTinPresenceByIds(
  tenantSlug: string,
  memberIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, boolean>> {
  if (memberIds.length === 0) return new Map();
  // Deliberately OUTSIDE the try: `asTenantContext` throws
  // InvalidTenantSlugError on a malformed slug — a CALLER BUG that must
  // propagate, never degrade into the silent empty-map fallback (065 L-2).
  const ctx = asTenantContext(tenantSlug);
  try {
    return await runInTenant(ctx, (tx) =>
      memberTinPresenceByIdsInTx(tx, asTenantId(tenantSlug), memberIds),
    );
  } catch (e) {
    // What remains catchable here is infrastructure (runInTenant connection /
    // RLS GUC / the members SELECT) — `asTenantId` is a rubber-stamp brander
    // (validated by asTenantContext above) and cannot throw. 065 L-2: carry
    // `errName` so a future programming-error class (TypeError etc.) is
    // distinguishable from a Neon blip in the logs; 065 L-1: alertable
    // degradation counter (the warn alone is not ops-pageable).
    logger.warn(
      {
        event: 'f6_member_tin_presence_lookup_failed',
        tenant_slug: tenantSlug,
        member_id_count: memberIds.length,
        errName: e instanceof Error ? e.name : 'unknown',
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6] buyerHasTin enrichment lookup failed — registrations fall back to the legacy matched⇒has-TIN guess',
    );
    eventcreateMetrics.tinEnrichmentDegraded(tenantSlug);
    return new Map();
  }
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
 * `quota_credit_back_archive` audit row (matching the
 * `quota_credit_back_refund` flow in the ingest-webhook-attendee
 * pipeline — emitted via `_helpers/process-attendee-in-tx.ts`). The previous
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

/**
 * Phase 9 / US6 — composes the relink-registration deps bag. Bundles
 * every port the use-case consumes: events + registrations repos for
 * the load + UPDATE path, the F2/F3 plan-and-member quota-accounting
 * adapter for the credit-back-then-decrement computation, the per-
 * (tenant, member, event) advisory-lock acquirer (same
 * `eventcreate-quota:` namespace as ingest/archive/toggle so concurrent
 * paths serialise correctly), and the audit emitter. All bound to the
 * caller's tx.
 */
export function makeRelinkRegistrationDeps(
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
 * Phase 9 / US6 — route-facing wrapper for `relinkRegistration`. Uses
 * `runInTenantWithRollbackOnErr` so a mid-flight failure (lock
 * contention, audit-emit DB blip, quota-lookup error after credit-back
 * audits have already been emitted) rolls back the entire tx — the
 * registration row, every audit row, and every quota-derived count
 * snap back to the pre-relink state, preserving FR-037 strict-tx ACID
 * the same way archive + toggle do.
 *
 * NOTE: no duration histogram yet — Phase 10's observability batch
 * (T124–T130) owns metric wiring. Phase 9's contract is the surface
 * + correctness; metrics land later.
 */
export async function runRelinkRegistration(
  tenantSlug: string,
  input: Omit<RelinkRegistrationInput, 'tenantId'>,
): Promise<Result<RelinkRegistrationOutput, RelinkRegistrationError>> {
  const ctx = asTenantContext(tenantSlug);
  const tenantId: TenantId = asTenantId(tenantSlug);
  return runInTenantWithRollbackOnErr(ctx, async (tx) => {
    const deps = makeRelinkRegistrationDeps(tx, ctx);
    return relinkRegistration({ ...input, tenantId }, deps);
  });
}

/**
 * Phase 10 T110 — composes the erase-attendee-pii deps bag for FR-032a
 * admin erasure. Bundles every port the use-case consumes: events +
 * registrations repos (for the find→delete path), the advisory-lock
 * acquirer (same `eventcreate-quota:` namespace as ingest/archive/toggle
 * so a concurrent ingest blocks until this erasure commits), and the
 * audit emitter (now also queried for the prior-erasure idempotency
 * probe via the new `findPriorErasureCompletion` method). All bound to
 * the caller's tx.
 */
export function makeEraseAttendeePiiDeps(executor: TenantTx) {
  return {
    eventsRepo: makeDrizzleEventsRepository(executor),
    registrationsRepo: makeDrizzleRegistrationsRepository(executor),
    advisoryLockAcquirer: makeDrizzleAdvisoryLockAcquirer(executor),
    audit: makePinoAuditPort(executor),
  };
}

/**
 * Phase 10 T110 — route-facing wrapper for `eraseAttendeePii`. Uses
 * `runInTenantWithRollbackOnErr` so any mid-flight failure (lock
 * contention, audit-emit DB blip, hardDelete invariant violation)
 * rolls back the entire tx — the `pii_erasure_requested` + credit-back
 * audit rows are undone alongside the registration row state,
 * preserving FR-037 strict-tx ACID the same way archive + toggle +
 * relink do. The macro `pii_erasure_completed` audit thus represents
 * a TRUE successful erasure, never a "we tried but bailed" half-state.
 */
export async function runEraseAttendeePii(
  tenantSlug: string,
  input: Omit<EraseAttendeePiiInput, 'tenantId'>,
): Promise<Result<EraseAttendeePiiOutput, EraseAttendeePiiError>> {
  const ctx = asTenantContext(tenantSlug);
  const tenantId: TenantId = asTenantId(tenantSlug);
  return runInTenantWithRollbackOnErr(ctx, async (tx) => {
    const deps = makeEraseAttendeePiiDeps(tx);
    return eraseAttendeePii({ ...input, tenantId }, deps);
  });
}

/**
 * F6 remediation PR 2.1 / P2 (FR-032a by-email erasure BACKEND) — route-facing
 * wrapper for `searchAttendeeRegistrationsByEmail`. This is the PREVIEW read
 * that lists every registration sharing a data subject's email across the
 * tenant's events before the destructive bulk erase (P3).
 *
 * READ path → plain `runInTenant` (NO rollback wrapper — nothing mutates).
 * Composes the P1 registrations repo (`findByEmailLower`) + the batched
 * event-details lookup, both bound to the SAME tenant-scoped tx so RLS
 * (`SET LOCAL app.current_tenant`) + the explicit tenant predicate scope both
 * reads (Principle I two-layer isolation). A batch-lookup error DEGRADES inside
 * the use-case to a null event name (mirrors `runListEventNamesByIds`), so the
 * preview never 500s because the enrichment blipped.
 */
export async function runSearchAttendeesByEmail(
  tenantSlug: string,
  input: { readonly emailLower: string },
): Promise<
  Result<
    SearchAttendeeRegistrationsByEmailOutput,
    SearchAttendeeRegistrationsByEmailError
  >
> {
  const ctx = asTenantContext(tenantSlug);
  const tenantId: TenantId = asTenantId(tenantSlug);
  return runInTenant(ctx, async (tx) => {
    const deps = {
      registrationsRepo: makeDrizzleRegistrationsRepository(tx),
      eventDetailsBatchLookup: makeEventDetailsBatchLookupForTenant(tx),
    };
    return searchAttendeeRegistrationsByEmail(
      { tenantId, emailLower: input.emailLower },
      deps,
    );
  });
}
