/**
 * Application port — F6 event registration fan-out erasure for the
 * member-erasure cascade (COMP-1 US2c, GDPR Art. 17 / PDPA §33).
 *
 * Hard-deletes every F6 event registration matched to an erased member (each
 * carries the attendee's email / name / company), crediting back any consumed
 * benefit quota per registration. Wired into `erase-member` as a POST-COMMIT
 * best-effort cascade (mirroring the F7 content-scrub + F8 cycle-cancel
 * cascade ports).
 *
 * Cross-module note: event registrations live in F6 (`events/application`).
 * The adapter is the single allowed crossing point for F3 use-cases;
 * Application-layer callers depend only on this port. The adapter calls F6's
 * barrel export `eraseAllRegistrationsForMember`. This file (members
 * Application layer) imports ZERO F6 symbols — only the F3 `MemberId` domain
 * type + the cross-cutting `TenantContext`.
 *
 * Tx semantics: the F6 fan-out opens its OWN per-registration `runInTenant`
 * tx (one per row, so a single registration's rollback never poisons the
 * others — the best-effort guarantee). The F3 caller does NOT pass its own
 * tx — the cascade runs after the member-row mutation has committed, mirroring
 * the F7/F8 cascade ports.
 *
 * Outcome contract: best-effort, three-way discriminated union.
 *   - `'ok'`      → the fan-out ran end-to-end with NO per-registration
 *                   failures (`failedCount === 0`). `erasedCount` may be 0
 *                   when the member had no matched registrations.
 *   - `'partial'` → the fan-out ran but ≥1 registration failed
 *                   (`failedCount > 0`). The member-row erasure still
 *                   succeeds; the F3 caller flips its cascade-completion flag
 *                   so the US2d reconciler re-drives the remaining rows on a
 *                   later sweep (idempotent: a re-run enumerates 0 of the
 *                   already-deleted rows).
 *   - `'failed'`  → the fan-out call threw at the calling convention (e.g. a
 *                   deps-factory failure). The F6 fan-out is itself
 *                   never-erring, so this arm is defensive — the F3 caller
 *                   flips its cascade-completion flag (no swallow-to-no-op).
 *
 * The return is a DISCRIMINATED UNION on `outcome` so the counts-present-IFF-
 * outcome invariant is compiler-enforced (the US2b /speckit-review lesson):
 * `'ok'` REQUIRES `erasedCount`; `'partial'` REQUIRES both counts; `'failed'`
 * forbids them. An illegal `{ outcome: 'ok' }` (no count) cannot compile — the
 * consumer (`erase-member`) narrows on `outcome` before reading the counts.
 */
import type { MemberId } from '../../domain/member';
import type { TenantContext } from '@/modules/tenants';

export interface EventRegistrationErasurePort {
  /**
   * Hard-delete every F6 registration matched to the member, crediting back
   * any consumed benefit quota. Idempotent — a replay enumerates 0 of the
   * already-deleted rows.
   *
   * `meta.actorUserId` records the F3 admin who initiated the erasure
   * (carried into the per-registration F6 PII-erasure audits). `meta.requestId`
   * threads the forensic request id.
   *
   * Returns the discriminated union described in the file header. Never throws
   * — a throw at the calling convention is caught and mapped to
   * `{ outcome: 'failed' }`.
   */
  eraseAllForMember(
    tenant: TenantContext,
    memberId: MemberId,
    meta: { readonly actorUserId: string; readonly requestId: string | null },
  ): Promise<
    | { readonly outcome: 'ok'; readonly erasedCount: number }
    | {
        readonly outcome: 'partial';
        readonly erasedCount: number;
        readonly failedCount: number;
      }
    | { readonly outcome: 'failed' }
  >;
}
