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

/**
 * PR 4.1 follow-up #1 — bounded-safety guard for the server-side auto-loop.
 *
 * The fan-out RE-enumerates (`list`) after each erased batch until the sweep
 * drains. `MAX_SWEEP_ITERATIONS` caps the number of enumerate-then-erase
 * batches so a pathological non-draining state (a row that neither erases nor
 * drops out of the live table) can NEVER spin unbounded. 50 batches × the
 * `FIND_BY_EMAIL_CAP` (500) row ceiling ≈ 25,000 registrations for a single
 * data subject — a generous pathological bound far above realistic SweCham
 * scale (one attendee shares a handful of registrations). If the guard trips,
 * the fan-out returns `truncated:true` (incomplete) so the admin re-drives.
 *
 * This is the LOGICAL bound on the loop; the route's `maxDuration` is only a
 * wall-clock backstop (a timeout still leaves every committed per-row erasure
 * intact + the sweep idempotently re-drivable).
 */
export const MAX_SWEEP_ITERATIONS = 50;

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
   * `true` when the sweep did NOT genuinely drain, so residual PII may survive
   * and the caller MUST re-drive the DSR (idempotent — erased rows drop out on
   * re-enumeration). Since PR 4.1 the fan-out AUTO-LOOPS the enumeration
   * (follow-up #1), so a merely cap-truncated enumeration no longer surfaces
   * here — the loop re-drives it internally. `truncated:true` now means the
   * loop stopped INCOMPLETE for one of:
   *   - a batch had a FAILURE (`failedCount > 0`) — the failed row stays in the
   *     table, so the loop broke rather than spin on it; OR
   *   - the `MAX_SWEEP_ITERATIONS` safety guard tripped (pathological
   *     non-draining state).
   * `truncated:false` is emitted ONLY when the fan-out looped to completion
   * with zero failures and the guard never tripped — i.e. a genuinely COMPLETE
   * Art. 17 / PDPA §33 erasure across every registration sharing the email.
   * (Was: a straight passthrough of the `list` cap — I-1 review finding.)
   */
  readonly truncated: boolean;
}

export interface EraseAttendeeRegistrationsByEmailDeps {
  /**
   * Enumerate every registration sharing the (lowered) attendee email (one
   * read), capped at `FIND_BY_EMAIL_CAP`. `truncated` reports whether the cap
   * hid additional rows; the fan-out uses it to decide whether to RE-enumerate
   * for the next batch (PR 4.1 auto-loop) — a truncated batch means more rows
   * remain, so the loop re-`list`s after erasing this batch. Each call re-reads
   * the LIVE table, so hard-deleted rows from prior batches drop out.
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
  let erasedCount = 0;
  let alreadyErasedCount = 0;
  let failedCount = 0;
  let iterations = 0;
  // `complete` = did the sweep GENUINELY drain? Only then is `truncated:false`.
  let complete = false;

  // PR 4.1 follow-up #1 — SERVER-SIDE AUTO-LOOP. A data subject with more than
  // `FIND_BY_EMAIL_CAP` registrations used to get one capped batch erased +
  // `truncated:true`, leaving completeness to a manual admin re-drive. Now the
  // fan-out loops: erased rows are HARD-DELETED, so each re-`list` re-reads the
  // live table and returns the NEXT ≤CAP rows — repeat until the sweep drains.
  //
  // TERMINATION INVARIANTS (all three are guarded — a DESTRUCTIVE PII path must
  // never spin unbounded). Order matters; the checks below fire in this order:
  //   (0) EMPTY batch (top of loop) → nothing (more) to erase → COMPLETE.
  //   (1) ANY failure in a batch → STOP IMMEDIATELY, do NOT re-`list`. A row
  //       that failed to erase STAYS in `event_registrations`, so the next
  //       enumeration would return it AGAIN — an infinite loop on the failing
  //       row. Break with `complete=false` (→ `truncated:true`) so the admin
  //       re-drives after fixing the failure. Checked BEFORE the not-truncated
  //       check so a failure ALWAYS forces incompleteness, even for a
  //       non-cap-truncated batch (the failed row is itself residual PII).
  //   (2) batch NOT truncated (< CAP+1 rows) + no failures → every remaining
  //       row was erased → the sweep genuinely DRAINED. COMPLETE without a
  //       wasteful confirming re-`list` (so the realistic sub-cap case still
  //       calls `list` exactly once — unchanged behaviour).
  //   (3) iteration guard `MAX_SWEEP_ITERATIONS` → STOP. A pathological
  //       non-draining state (e.g. a row that neither erases nor drops out)
  //       can never spin unbounded. Break with `complete=false`.
  // `alreadyErased` rows never cause a loop: an ok+alreadyErased result means
  // the row is already gone from the live table (hard-deleted / hash-mismatched
  // pseudonym), so it does not re-enumerate.
  //
  // The error channel stays `never`: row-level failures are TALLIED (best-
  // effort), never thrown. Only a `list` enumerate-throw propagates (unguarded,
  // as before) to the route boundary.
  while (true) {
    const { registrations, truncated } = await deps.list(
      input.tenantId,
      input.emailLower,
    );

    if (registrations.length === 0) {
      // Drained (or nothing matched at all).
      complete = true;
      break;
    }

    iterations += 1;

    // Per-batch failure tally — drives the STOP-on-failure invariant. Distinct
    // from the aggregate `failedCount` which accumulates across all batches.
    let batchFailed = 0;

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
          batchFailed += 1;
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
        batchFailed += 1;
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

    // (1) STOP-on-failure — the CRITICAL loop-termination invariant. Checked
    // before the not-truncated / guard checks so a failed row (which stays in
    // the table and would re-enumerate forever) never lets the loop spin, and
    // always marks the sweep incomplete.
    if (batchFailed > 0) {
      complete = false;
      break;
    }

    // (2) A non-truncated batch erased with zero failures → drained.
    if (!truncated) {
      complete = true;
      break;
    }

    // (3) Bounded-safety guard — bail before re-enumerating past the cap.
    if (iterations >= MAX_SWEEP_ITERATIONS) {
      complete = false;
      break;
    }
  }

  return ok({ erasedCount, alreadyErasedCount, failedCount, truncated: !complete });
}
