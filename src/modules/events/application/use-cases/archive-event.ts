/**
 * Phase 6 wave-4 — `archiveEvent` use-case (F6 Application).
 *
 * Admin archive action per FR-019a. Atomically:
 *   1. Loads the event via `eventsRepo.findById` →
 *      `event_not_found` / `already_archived` short-circuits.
 *   2. SELECTs every matched paid non-pseudonymised registration via
 *      `registrationsRepo.listForRequota` (ordered by
 *      `matched_member_id ASC` for deadlock-safe lock order).
 *   3. UPDATEs `events.archived_at = NOW()` via
 *      `eventsRepo.setArchived`.
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
import type { F6AuditPort } from '../ports/audit-port';
import type { AdvisoryLockAcquirer } from '../ports/advisory-lock-acquirer';
import type { UserId } from '@/modules/auth';
import { buildQuotaLockKey } from './apply-quota-effect';
import {
  eventsRepoErrorMessage,
  registrationsRepoErrorMessage,
} from './_helpers/repo-error-message';

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
 * **IMP-5 wave-5 batch-3** — repo errors carry `cause` discriminator
 * (see toggle-event-category.ts for the full pattern rationale).
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
  | { readonly kind: 'lock_acquisition_failed'; readonly message: string }
  | { readonly kind: 'audit_emit_failed'; readonly message: string };

export interface ArchiveEventDeps {
  readonly eventsRepo: EventsRepository;
  readonly registrationsRepo: RegistrationsRepository;
  readonly advisoryLockAcquirer: AdvisoryLockAcquirer;
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

  // (2) Snapshot the rows that need credit-back BEFORE we archive the
  // event. Ordered by matched_member_id ASC for deadlock-safe lock
  // acquisition.
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

  // (3) UPDATE the event flag.
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

  let partnershipReversals = 0;
  let culturalReversals = 0;

  // (4) Per-row credit-back. Each row gets its own advisory lock so
  // concurrent ingests on the same (member, event) block until our
  // archive commits.
  for (const reg of counted) {
    const memberId = reg.match.matchedMemberId;
    if (memberId === null) continue;

    try {
      await deps.advisoryLockAcquirer.acquire(
        buildQuotaLockKey(input.tenantId, memberId, input.eventId),
      );
    } catch (e) {
      return err({
        kind: 'lock_acquisition_failed',
        message: (e as Error)?.message ?? 'unknown',
      });
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

    const baseAudit = {
      tenantId: input.tenantId,
      actorType: 'admin' as const,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
    };

    if (wasPartnership) {
      const r = await deps.audit.emit({
        ...baseAudit,
        eventType: 'quota_credit_back_archive',
        summary: `partnership credit-back via archive: registration ${reg.registrationId}`,
        payload: {
          severity: 'info',
          registrationId: reg.registrationId,
          memberId,
          scope: 'partnership',
          // allotmentAfter is left as 0 here because the archive
          // already nuked the row's contribution; consumed-count for
          // the (member, event) now drops by 1, but the canonical
          // counter is computed-on-read and never persisted. The
          // event_archived macro audit carries the aggregate reversal
          // count (registrationsAffected) — that's the more useful
          // dashboard metric.
          allotmentAfter: 0,
        },
      });
      if (!r.ok) {
        return err({
          kind: 'audit_emit_failed',
          message:
            'message' in r.error ? r.error.message : `audit error ${r.error.kind}`,
        });
      }
      partnershipReversals += 1;
    }

    if (wasCultural) {
      const r = await deps.audit.emit({
        ...baseAudit,
        eventType: 'quota_credit_back_archive',
        summary: `cultural credit-back via archive: registration ${reg.registrationId}`,
        payload: {
          severity: 'info',
          registrationId: reg.registrationId,
          memberId,
          scope: 'cultural',
          allotmentAfter: 0,
        },
      });
      if (!r.ok) {
        return err({
          kind: 'audit_emit_failed',
          message:
            'message' in r.error ? r.error.message : `audit error ${r.error.kind}`,
        });
      }
      culturalReversals += 1;
    }
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
    return err({
      kind: 'audit_emit_failed',
      message:
        'message' in macro.error
          ? macro.error.message
          : `audit error ${macro.error.kind}`,
    });
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
