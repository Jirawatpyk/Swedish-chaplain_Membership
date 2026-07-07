/**
 * F6 remediation PR 2.1 / P3 (FR-032a by-email erasure BACKEND) —
 * `eraseAttendeeRegistrationsByEmail` best-effort bulk fan-out use-case
 * (throw-path-critical).
 *
 * GDPR Art. 17 / PDPA §33: an admin handling a data-subject-request must be
 * able to erase EVERY event registration carrying the subject's attendee PII
 * (email / name / company) across all of a tenant's events — not just the
 * member-matched ones the COMP-1 cascade reaches (which keys on
 * `matched_member_id` and never touches NON-MEMBER guest attendees). This
 * use-case is a near-clone of `eraseAllRegistrationsForMember` but enumerates
 * by attendee email instead of matched member: it lists every registration
 * sharing the email (via the `list` dep) and loops the existing
 * single-registration `eraseAttendeePii` semantics (via `eraseOne`) once per
 * row.
 *
 * OWN-TX-PER-ROW (the correctness-critical piece): each `eraseOne` runs in its
 * OWN `runInTenant` tx (the composition factory wires `runEraseAttendeePii` per
 * call), NOT one shared tx. A shared tx would let a single DB-poisoned row
 * (e.g. a Postgres error mid-loop) ROLL BACK the whole DSR — turning a
 * one-row failure into a zero-row erasure. Per-row isolation means a failure
 * on one registration does not undo the siblings' hard-deletes.
 *
 * BEST-EFFORT: a failure on one registration — whether an `err` Result OR a
 * raw throw — must NOT abort the rest of the loop. Failures are TALLIED, not
 * swallowed:
 *   - `erasedCount`        — `eraseOne` ok, freshly deleted this run.
 *   - `alreadyErasedCount` — `eraseOne` ok, idempotent (prior erasure — the row
 *                            was already gone but a prior `pii_erasure_completed`
 *                            audit existed, so `eraseAttendeePii` returned ok).
 *   - `failedCount`        — `eraseOne` returned err, or threw.
 *
 * The use-case NEVER returns `err` (the `Result` error channel is `never`).
 * `failedCount > 0` is NOT an error — it is a best-effort signal the caller (a
 * future admin route / reconciler) reads to re-drive the remaining rows on a
 * later sweep (idempotent: a re-run enumerates only the still-live rows, since
 * the enumeration keys on the live `event_registrations` table and
 * hard-deleted rows drop out).
 *
 * Observability: each failure is logged with `registrationId` (a uuid) + the
 * error CLASS name (`errKind`) — NEVER the raw error message (a Postgres error
 * can embed SQL param VALUES = the attendee PII; member-cascade FIX-D
 * precedent) and NEVER the attendee email / name / company OR the searched
 * email (that PII is exactly what we are erasing).
 *
 * Constitution Principle III: pure Application — the two collaborators are
 * plain deps (no Drizzle / `runInTenant` / framework imports) so the use-case
 * is unit-testable without a real tx. The composition wrapper
 * `runEraseAttendeesByEmail` (in `src/lib/events-admin-deps.ts`) wires `list` →
 * `findByEmailLower` (one enumerate-tx) and `eraseOne` →
 * `runEraseAttendeePii(...)` (its own tx per row). Reuses the shipped audit
 * events (`pii_erasure_requested` / `pii_erasure_completed` /
 * `quota_credit_back_archive`) emitted by `eraseAttendeePii` — NO new type.
 */
import { ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';

export interface EraseAttendeeRegistrationsByEmailInput {
  readonly tenantId: string;
  readonly emailLower: string;
  readonly actorUserId: string;
  /** Admin-supplied reason text; threaded to each per-registration erasure. */
  readonly reasonText: string;
  readonly occurredAt: Date;
}

export interface EraseAttendeeRegistrationsByEmailOutput {
  readonly erasedCount: number;
  readonly alreadyErasedCount: number;
  readonly failedCount: number;
  /**
   * `true` when the enumeration was CAPPED (`FIND_BY_EMAIL_CAP`) — i.e. the
   * subject had MORE registrations than were erased in THIS pass, so PII
   * survives beyond the cap. The caller MUST NOT read a truncated
   * `{erasedCount:CAP, failedCount:0}` as a COMPLETE Art. 17 DSR — it must
   * re-drive the sweep to completeness (idempotent: erased rows drop out on
   * re-enumeration). I-1 review finding; propagated from `list`.
   */
  readonly truncated: boolean;
}

export interface EraseAttendeeRegistrationsByEmailDeps {
  /**
   * Enumerate every registration sharing the (lowered) attendee email (one
   * read), capped at `FIND_BY_EMAIL_CAP`. `truncated` reports whether the cap
   * hid additional rows — threaded straight to the use-case output so a capped
   * pass is never mistaken for a complete erasure.
   */
  list(
    tenantId: string,
    emailLower: string,
  ): Promise<{
    readonly registrations: ReadonlyArray<{
      readonly registrationId: string;
      readonly eventId: string;
    }>;
    readonly truncated: boolean;
  }>;
  /**
   * Erase a single registration (own tx). Resolves to an `ok` Result carrying
   * `{ alreadyErased }`, or an `err` Result, or THROWS — the fan-out tolerates
   * all three (best-effort).
   */
  eraseOne(
    registrationId: string,
    eventId: string,
    input: {
      readonly tenantId: string;
      readonly actorUserId: string;
      readonly reasonText: string;
      readonly occurredAt: Date;
    },
  ): Promise<Result<{ readonly alreadyErased: boolean }, unknown>>;
}

export async function eraseAttendeeRegistrationsByEmail(
  input: EraseAttendeeRegistrationsByEmailInput,
  deps: EraseAttendeeRegistrationsByEmailDeps,
): Promise<Result<EraseAttendeeRegistrationsByEmailOutput, never>> {
  const { registrations, truncated } = await deps.list(
    input.tenantId,
    input.emailLower,
  );

  let erasedCount = 0;
  let alreadyErasedCount = 0;
  let failedCount = 0;

  for (const { registrationId, eventId } of registrations) {
    try {
      const r = await deps.eraseOne(registrationId, eventId, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        reasonText: input.reasonText,
        occurredAt: input.occurredAt,
      });
      if (!r.ok) {
        failedCount += 1;
        // registrationId only — NEVER the searched email or attendee PII.
        logger.error(
          { registrationId },
          'erase-attendees-by-email: eraseOne not ok',
        );
      } else if (r.value.alreadyErased) {
        alreadyErasedCount += 1;
      } else {
        erasedCount += 1;
      }
    } catch (e) {
      failedCount += 1;
      logger.error(
        {
          registrationId,
          // Forbidden-log hygiene (COMP-1 PR-review FIX D): error CLASS name
          // only, never the raw message (it can embed SQL param VALUES =
          // attendee PII) and never the searched email.
          errKind: e instanceof Error ? e.constructor.name : 'unknown',
        },
        'erase-attendees-by-email: eraseOne threw',
      );
    }
  }

  return ok({ erasedCount, alreadyErasedCount, failedCount, truncated });
}
