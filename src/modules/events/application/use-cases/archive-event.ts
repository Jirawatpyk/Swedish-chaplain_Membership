/**
 * Phase 6 wave-4 — `archiveEvent` use-case (F6 Application).
 *
 * Admin archive action per FR-019a. Atomically:
 *   1. Loads the event via `eventsRepo.findById` →
 *      `event_not_found` / `already_archived` short-circuits.
 *   2. UPDATEs `events.archived_at = NOW()` via
 *      `eventsRepo.setArchived` FIRST so any concurrent ingest landing
 *      between this step and step 3 below sees `archived_at !== null`
 *      and short-circuits in `applyQuotaEffect` (cannot insert a new
 *      counted=true row). This makes the no-new-counted-row invariant
 *      EXPLICIT at the code level rather than implicit via the
 *      per-(member, event) advisory lock acquired later in step 4.
 *   3. SELECTs every previously-counted registration via
 *      `registrationsRepo.listForRequota` (ordered by
 *      `matched_member_id ASC` for deadlock-safe lock order in step 4).
 *      Snapshot taken AFTER the archive UPDATE is the strongest
 *      invariant: any row not in this list is guaranteed to either
 *      already be counted=false or be a future ingest that will
 *      short-circuit on the now-archived flag.
 *   4. For each previously-counted registration row:
 *        a. Acquire the per-(tenant, member, event) advisory lock —
 *           same `eventcreate-quota:` namespace the ingest path uses
 *           so a concurrent ingest blocks until this archive commits.
 *        b. UPDATE counted_against_* = false via
 *           `registrationsRepo.setQuotaEffect`.
 *        c. Emit ONE `quota_credit_back_archive` audit per previously-
 *           true scope (partnership and/or cultural).
 *   5. Emit the macro `event_archived` audit with
 *      `registrationsAffected` + `quotaReversals.{partnership,cultural}`
 *      counts.
 *
 * Per FR-019a archive is admin-only (manager + member get 404 at the
 * route boundary). Archived events are quota-neutral — future
 * webhook deliveries to the same `(source, externalId)` upsert the
 * event metadata normally but `apply-quota-effect` short-circuits on
 * `event.archivedAt !== null`, so no new quota is decremented.
 *
 * Constitution Principle III: pure Application — no framework imports.
 * Caller (route handler) owns the tx via `runInTenantTx` / the
 * `archive-event-deps` composition root.
 */
import { ok, err, type Result } from '@/lib/result';
import type { TenantId } from '@/modules/members';
import type { EventId } from '../../domain/branded-types';
import type { EventAggregate } from '../../domain/event';
import type {
  EventsRepository,
  EventsRepositoryError,
} from '../ports/events-repository';
import type {
  RegistrationsRepository,
  RegistrationsRepositoryError,
} from '../ports/registrations-repository';
import type { F6AuditPort, AuditEmitError } from '../ports/audit-port';
import type {
  AdvisoryLockAcquirer,
  InvalidLockKeyError,
} from '../ports/advisory-lock-acquirer';
import type {
  QuotaAccountingPort,
  QuotaAccountingError,
  PlanAllotments,
  ConsumedQuota,
} from '../ports/quota-accounting-port';
import type { UserId } from '@/modules/auth';
import { buildQuotaLockKey } from './apply-quota-effect';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import {
  eventsRepoErrorMessage,
  registrationsRepoErrorMessage,
  quotaAccountingErrorMessage,
} from './_helpers/repo-error-message';
import {
  wrapAuditEmitFailure,
  wrapLockFailure,
} from './_helpers/error-wrappers';

export interface ArchiveEventInput {
  readonly tenantId: TenantId;
  readonly eventId: EventId;
  readonly actorUserId: UserId;
  readonly occurredAt: Date;
}

export interface ArchiveEventOutput {
  readonly event: EventAggregate;
  readonly registrationsAffected: number;
  readonly quotaReversals: {
    readonly partnership: number;
    readonly cultural: number;
  };
}

/**
 * **IMP-5 wave-5 batch-3 + R2-TYPE-B + R3-CRIT-2 + R3-IMP-5 (round-12)** —
 * every variant carries a `cause` discriminator where applicable so route
 * handlers can surface the retry-eligibility context for SRE runbooks:
 *   - `events_repo_error` / `registrations_repo_error` → `cause` carries the
 *     discriminated repo error (db_error | invariant_violation |
 *     pseudonymised_row_rejected | not_implemented)
 *   - `lock_acquisition_failed.cause: Error` — transient, retry-eligible
 *   - `lock_key_invariant_violation.cause: InvalidLockKeyError` —
 *     programmer error / schema drift, page on-call, DO NOT retry
 *   - `audit_emit_failed.cause: AuditEmitError` — `db_error |
 *     enum_value_unknown` for the inner audit-port failure
 * Route handlers extract via the pino `err: ... .cause` log key (NOT
 * the legacy `cause:` key — pino auto-serializes `err`).
 */
export type ArchiveEventError =
  | { readonly kind: 'event_not_found'; readonly eventId: EventId }
  | { readonly kind: 'already_archived'; readonly eventId: EventId }
  | {
      readonly kind: 'events_repo_error';
      readonly message: string;
      readonly cause: EventsRepositoryError;
    }
  | {
      readonly kind: 'registrations_repo_error';
      readonly message: string;
      readonly cause: RegistrationsRepositoryError;
    }
  | {
      readonly kind: 'lock_acquisition_failed';
      readonly message: string;
      readonly cause: Error;
    }
  | {
      readonly kind: 'lock_key_invariant_violation';
      readonly message: string;
      readonly cause: InvalidLockKeyError;
    }
  | {
      readonly kind: 'audit_emit_failed';
      readonly message: string;
      readonly cause: AuditEmitError;
    }
  | {
      /**
       * Phase 6 staff-review-4 SUGG-2 closure — `queryAllotments` for the
       * post-credit-back `allotmentAfter` value failed. Matches the
       * F4 refund credit-back pattern so the audit payload carries an
       * accurate "slots remaining after this credit" rather than a `0`
       * sentinel. A `quota_lookup_failed` here aborts the archive tx
       * (FR-037 strict-tx) so the audit log never carries stale data.
       *
       * **R6 REL-R6-01 closure** — `message` field added for shape
       * consistency with `events_repo_error` / `registrations_repo_error`
       * / `lock_*` / `audit_emit_failed` variants. Route handlers using
       * `error.message` for RFC 7807 `detail` rendering now get a
       * meaningful string instead of `undefined`.
       */
      readonly kind: 'quota_lookup_failed';
      readonly message: string;
      readonly cause: QuotaAccountingError;
    };

export interface ArchiveEventDeps {
  readonly eventsRepo: EventsRepository;
  readonly registrationsRepo: RegistrationsRepository;
  readonly advisoryLockAcquirer: AdvisoryLockAcquirer;
  /**
   * Phase 6 staff-review-4 SUGG-2 — needed to compute actual
   * `allotmentAfter` per credit-back audit row, matching the refund
   * credit-back pattern. The previous implementation hardcoded
   * `allotmentAfter: 0` as a sentinel which forensic dashboards
   * filtering on `allotmentAfter > 0` would silently skip.
   */
  readonly quotaAccountingPort: QuotaAccountingPort;
  readonly audit: F6AuditPort;
}

export async function archiveEvent(
  input: ArchiveEventInput,
  deps: ArchiveEventDeps,
): Promise<Result<ArchiveEventOutput, ArchiveEventError>> {
  // (1) Load event
  const eventLookup = await deps.eventsRepo.findById(input.tenantId, input.eventId);
  if (!eventLookup.ok) {
    return err({
      kind: 'events_repo_error',
      message: eventsRepoErrorMessage(eventLookup.error),
      cause: eventLookup.error,
    });
  }
  const eventBefore = eventLookup.value;
  if (!eventBefore) {
    return err({ kind: 'event_not_found', eventId: input.eventId });
  }
  if (eventBefore.archivedAt !== null) {
    return err({ kind: 'already_archived', eventId: input.eventId });
  }

  // (2) UPDATE the event flag FIRST so applyQuotaEffect short-circuits
  // for any concurrent ingest landing after this point — the
  // archived_at !== null check at apply-quota-effect.ts means no NEW
  // counted=true row can be inserted from now on. This makes the
  // post-snapshot safety invariant EXPLICIT rather than implicit via
  // the per-(member, event) advisory lock acquired in step 4.
  const setArchivedResult = await deps.eventsRepo.setArchived(
    input.tenantId,
    input.eventId,
    input.occurredAt,
  );
  if (!setArchivedResult.ok) {
    return err({
      kind: 'events_repo_error',
      message: eventsRepoErrorMessage(setArchivedResult.error),
      cause: setArchivedResult.error,
    });
  }
  const eventAfter = setArchivedResult.value;

  // (3) Snapshot the rows that need credit-back AFTER the archive
  // commits inside this tx. Ordered by matched_member_id ASC for
  // deadlock-safe lock acquisition in step 4.
  const listResult = await deps.registrationsRepo.listForRequota(
    input.tenantId,
    input.eventId,
  );
  if (!listResult.ok) {
    return err({
      kind: 'registrations_repo_error',
      message: registrationsRepoErrorMessage(listResult.error),
      cause: listResult.error,
    });
  }
  const counted = listResult.value.filter(
    (r) =>
      r.quotaEffect.countedAgainstPartnership ||
      r.quotaEffect.countedAgainstCulturalQuota,
  );

  let partnershipReversals = 0;
  let culturalReversals = 0;

  // SUGG-2 staff-review-4 — derive fiscal year once outside the loop
  // for the cultural-scope queryAllotments call below. Asia/Bangkok
  // tenant fiscal year boundary is handled by `deriveFiscalYear`
  // (js-joda backed); SweCham fiscal-year-start-month=1 → fiscal year
  // equals calendar year. Other tenants can diverge later.
  const fiscalYear = deriveFiscalYear(eventBefore.startDate.toISOString(), 1);

  // **R6 PERF-R6-04 closure (R7 COMMENT-FR-02 clarified)** — batch
  // `queryAllotments` by unique memberId. Pre-loop: walk the `counted`
  // list and collect the unique set of `(memberId)` whose registrations
  // will be credit-backed. Issue ONE `queryAllotments` per unique member
  // to capture `(allotments, initialConsumed)` snapshot. Then inside
  // the per-row loop, instead of re-issuing `queryAllotments`, use the
  // cached allotments + an in-memory `decrementsCache` to track how
  // many rows we've credited back so far for THIS member —
  // `currentConsumed = initialConsumed - decrementsCache.<scope>`.
  // The audit emit's `allotmentAfter` then computes correctly as
  // `allotments.<scopeAllotment> - currentConsumed` without re-touching
  // the DB. RTT impact (queryAllotments calls only — setQuotaEffect +
  // audit-emit per row are unchanged):
  //   - Before: N × 1 = N queryAllotments calls (3 RTTs each)
  //   - After: M × 1 = M queryAllotments calls (3 RTTs each)
  // where M = |unique members| ≤ N. For events where M ≪ N (corporate
  // members registering multiple guests on the same event), this is a
  // meaningful saving. Benchmark with measured numbers tracked under
  // T154c (Phase 11 perf-bench follow-up if profiling shows need).
  type CachedAllotments = {
    readonly allotments: PlanAllotments;
    readonly initialConsumed: ConsumedQuota;
  };
  const allotmentsCache = new Map<string, CachedAllotments>();
  const decrementsCache = new Map<string, { partnership: number; cultural: number }>();
  const uniqueMembers = new Set<string>();
  for (const r of counted) {
    if (r.match.matchedMemberId !== null) {
      uniqueMembers.add(String(r.match.matchedMemberId));
    }
  }
  for (const m of uniqueMembers) {
    const lookup = await deps.quotaAccountingPort.queryAllotments({
      tenantId: input.tenantId,
      memberId: m as unknown as Parameters<typeof deps.quotaAccountingPort.queryAllotments>[0]['memberId'],
      eventId: input.eventId,
      fiscalYear,
    });
    if (!lookup.ok) {
      // R7 TYPE-FR-04 — use shared `quotaAccountingErrorMessage` helper
      // instead of inline ternary (exhaustiveness-checked via switch).
      return err({
        kind: 'quota_lookup_failed',
        message: `pre-loop ${quotaAccountingErrorMessage(lookup.error)}`,
        cause: lookup.error,
      });
    }
    allotmentsCache.set(m, {
      allotments: lookup.value.allotments,
      initialConsumed: lookup.value.consumed,
    });
  }

  // (4) Per-row credit-back. Each row gets its own advisory lock so
  // concurrent ingests on the same (member, event) block until our
  // archive commits.
  //
  // **R6 REL-R6-03 + PERF-R6-02 caveat (H3 dashboard-truth; R7 COMMENT-FR-03 corrected)**:
  // if this loop aborts mid-iteration (lock failure, queryAllotments
  // failure, or audit-emit failure), the surrounding tx ROLLS BACK via
  // `runInTenantWithRollbackOnErr` → all `event_registrations` UPDATEs
  // and `audit_log` INSERTs persisted so far are undone. However, OTel
  // counters incremented via `eventcreateMetrics.quotaCreditBack(...)`
  // in `pino-audit-port.ts:emitMatchingQuotaMetric` are NOT reversed
  // (counters are best-effort observability, not part of the tx).
  // Drift is bounded to `≤ 2 × currentIteration` phantom credit-back
  // counter increments per archive failure — EACH counted row can
  // emit BOTH partnership AND cultural credit-back audits (one per
  // scope, the two `if (wasPartnership)` / `if (wasCultural)` blocks
  // below are independent), and each emit fires one counter via the
  // dispatcher. Drift is observable via the accompanying
  // `logger.error` on the error path. The audit_log table remains
  // authoritative; counters are informational. Matches the F5
  // payment-receipt + F7 broadcast-delivery precedent.
  for (const reg of counted) {
    const memberId = reg.match.matchedMemberId;
    if (memberId === null) continue;

    try {
      await deps.advisoryLockAcquirer.acquire(
        buildQuotaLockKey(input.tenantId, memberId, input.eventId),
      );
    } catch (e) {
      return err(wrapLockFailure(e));
    }

    const wasPartnership = reg.quotaEffect.countedAgainstPartnership;
    const wasCultural = reg.quotaEffect.countedAgainstCulturalQuota;

    const upd = await deps.registrationsRepo.setQuotaEffect(
      input.tenantId,
      reg.registrationId,
      {
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
      },
    );
    if (!upd.ok) {
      return err({
        kind: 'registrations_repo_error',
        message: registrationsRepoErrorMessage(upd.error),
        cause: upd.error,
      });
    }

    // R6 PERF-R6-04 — read from pre-loop allotments cache instead of
    // re-issuing queryAllotments per row. The cache was populated
    // BEFORE the loop with one queryAllotments call per unique member,
    // and we track per-scope decrement counts in `decrementsCache` so
    // `currentConsumed = initialConsumed - decrementsSoFar` matches
    // the live DB state without an extra RTT.
    const memberKey = String(memberId);
    const cached = allotmentsCache.get(memberKey);
    if (!cached) {
      // R7 ERR-FR-04 — programmer error (NOT a transient DB failure):
      // `uniqueMembers` was populated from the same `counted` list, so
      // the cache MUST contain this member. Throw a plain Error here
      // instead of returning `quota_lookup_failed` (which is documented
      // as a TRANSIENT failure variant) — a synthesized
      // `member_not_found` cause would mislead the SRE runbook into a
      // data-integrity hunt rather than a code-regression hunt. The
      // throw escapes to `runInTenantWithRollbackOnErr`, which catches
      // it, rolls back the tx, and surfaces a 500 with full pino stack
      // for SRE diagnosis. Matches the "fail loud" intent of the
      // defensive check.
      throw new Error(
        `archive-event invariant: memberId ${memberKey} missing from ` +
          `pre-loop allotmentsCache (programmer error — uniqueMembers ` +
          `walk dropped a memberId; check counted-list / Set construction)`,
      );
    }
    const decrementsSoFar = decrementsCache.get(memberKey) ?? {
      partnership: 0,
      cultural: 0,
    };

    const baseAudit = {
      tenantId: input.tenantId,
      actorType: 'admin' as const,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
    };

    if (wasPartnership) {
      // Track THIS row's credit-back before computing the audit.
      decrementsSoFar.partnership += 1;
      const currentConsumed =
        cached.initialConsumed.partnershipConsumedForEvent - decrementsSoFar.partnership;
      const allotmentAfter =
        cached.allotments.partnershipPerEvent - currentConsumed;
      const r = await deps.audit.emit({
        ...baseAudit,
        eventType: 'quota_credit_back_archive',
        summary: `partnership credit-back via archive: registration ${reg.registrationId}`,
        payload: {
          severity: 'info',
          registrationId: reg.registrationId,
          memberId,
          scope: 'partnership',
          allotmentAfter,
        },
      });
      if (!r.ok) {
        return err(wrapAuditEmitFailure(r.error));
      }
      partnershipReversals += 1;
    }

    if (wasCultural) {
      decrementsSoFar.cultural += 1;
      const currentConsumed =
        cached.initialConsumed.culturalConsumedForYear - decrementsSoFar.cultural;
      const allotmentAfter =
        cached.allotments.culturalPerYear - currentConsumed;
      const r = await deps.audit.emit({
        ...baseAudit,
        eventType: 'quota_credit_back_archive',
        summary: `cultural credit-back via archive: registration ${reg.registrationId}`,
        payload: {
          severity: 'info',
          registrationId: reg.registrationId,
          memberId,
          scope: 'cultural',
          allotmentAfter,
        },
      });
      if (!r.ok) {
        return err(wrapAuditEmitFailure(r.error));
      }
      culturalReversals += 1;
    }

    decrementsCache.set(memberKey, decrementsSoFar);
  }

  // (5) Macro event_archived audit.
  const macro = await deps.audit.emit({
    eventType: 'event_archived',
    tenantId: input.tenantId,
    actorType: 'admin',
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt,
    summary: `event ${input.eventId} archived by admin ${input.actorUserId}; ${counted.length} registrations credit-backed (partnership=${partnershipReversals}, cultural=${culturalReversals})`,
    payload: {
      severity: 'info',
      actorUserId: input.actorUserId,
      eventId: input.eventId,
      registrationsAffected: counted.length,
      quotaReversals: {
        partnership: partnershipReversals,
        cultural: culturalReversals,
      },
    },
  });
  if (!macro.ok) {
    return err(wrapAuditEmitFailure(macro.error));
  }

  return ok({
    event: eventAfter,
    registrationsAffected: counted.length,
    quotaReversals: {
      partnership: partnershipReversals,
      cultural: culturalReversals,
    },
  });
}
