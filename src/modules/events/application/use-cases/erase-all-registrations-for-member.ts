/**
 * COMP-1 US2c (Member Erasure — F6 Registration Fan-out) —
 * `eraseAllRegistrationsForMember` best-effort fan-out use-case
 * (design §10, throw-path-critical).
 *
 * GDPR Art. 17 / PDPA §33: when a member is erased, every F6 event
 * registration matched to that member carries the attendee's email / name /
 * company and MUST be hard-deleted (crediting back any consumed benefit
 * quota per registration). This use-case enumerates the member's
 * registrations once (via the `list` dep) and loops calling the existing
 * single-registration `eraseAttendeePii` semantics (via the `eraseOne` dep)
 * once per row.
 *
 * BEST-EFFORT (the throw-path-critical piece): a failure on one
 * registration — whether an `err` Result OR a raw throw — must NOT abort
 * the rest of the loop. This mirrors the `eraseMember` post-commit cascade
 * philosophy: each per-registration `eraseOne` runs in its own tx (the
 * composition factory wires `runInTenant` per call), so one rollback does
 * not poison the others. Failures are TALLIED, not swallowed:
 *   - `erasedCount`        — `eraseOne` ok, freshly deleted this run.
 *   - `alreadyErasedCount` — `eraseOne` ok, idempotent (prior erasure).
 *   - `failedCount`        — `eraseOne` returned err, or threw.
 *
 * The use-case NEVER returns `err` (the `Result` error channel is `never`).
 * `failedCount > 0` is NOT an error — it is a best-effort signal the caller
 * (the eraseMember cascade) reads to mark the cascade not-clean so the US2d
 * reconciler re-drives the remaining registrations on a later sweep
 * (idempotent: a re-run enumerates 0 already-deleted rows).
 *
 * Observability: each failure is logged with `{ registrationId, memberId }`
 * (both uuids) + the error message — NEVER the attendee email / name /
 * company (that PII is exactly what we are erasing; logging it here would
 * defeat the purpose and breach the forbidden-fields rule).
 *
 * Constitution Principle III: pure Application — the two collaborators are
 * abstracted as plain deps (no Drizzle / `runInTenant` / framework imports)
 * so the use-case is unit-testable without a real tx. The Task 3
 * composition factory (`makeEraseAllRegistrationsForMemberDeps`) wires
 * `list` → `listMemberRegistrationsInTx` and `eraseOne` →
 * `runInTenant(eraseAttendeePii(...))`.
 */
import { ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';

export interface EraseAllRegistrationsForMemberInput {
  readonly tenantId: string;
  readonly memberId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly occurredAt: Date;
}

export interface EraseAllRegistrationsForMemberOutput {
  readonly erasedCount: number;
  readonly alreadyErasedCount: number;
  readonly failedCount: number;
}

export interface EraseAllRegistrationsForMemberDeps {
  /** Enumerate every registration matched to the member (one read). */
  list(
    tenantId: string,
    memberId: string,
  ): Promise<ReadonlyArray<{ readonly registrationId: string; readonly eventId: string }>>;
  /**
   * Erase a single registration (own tx). Resolves to an `ok` Result
   * carrying `{ alreadyErased }`, or an `err` Result, or THROWS — the
   * fan-out tolerates all three (best-effort).
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

export async function eraseAllRegistrationsForMember(
  input: EraseAllRegistrationsForMemberInput,
  deps: EraseAllRegistrationsForMemberDeps,
): Promise<Result<EraseAllRegistrationsForMemberOutput, never>> {
  const regs = await deps.list(input.tenantId, input.memberId);

  let erasedCount = 0;
  let alreadyErasedCount = 0;
  let failedCount = 0;

  for (const { registrationId, eventId } of regs) {
    try {
      const r = await deps.eraseOne(registrationId, eventId, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        reasonText: `member_erasure ${input.memberId}`,
        occurredAt: input.occurredAt,
      });
      if (!r.ok) {
        failedCount += 1;
        logger.error(
          { registrationId, memberId: input.memberId },
          'erase-all-registrations: eraseOne not ok',
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
          memberId: input.memberId,
          err: e instanceof Error ? e.message : String(e),
        },
        'erase-all-registrations: eraseOne threw',
      );
    }
  }

  return ok({ erasedCount, alreadyErasedCount, failedCount });
}
