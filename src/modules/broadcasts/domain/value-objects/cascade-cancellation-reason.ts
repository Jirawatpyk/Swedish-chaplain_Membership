/**
 * Spec 139 (review round 1 CR#8) — the reasons the F3 member cascade
 * (`cancelInFlightBroadcastsForMember`) writes into `broadcasts.cancellation_reason`.
 *
 * A Domain value object because two layers read it: the use case writes it,
 * and the erasure content scrub (`scrubContentForMemberInTx`) KEEPS a row's
 * `cancellation_reason` when it is one of these — they are system values, not
 * notes anyone typed, so they carry no PII. The members port's
 * `SystemCancellationReason` is the same union; a type test pins the two equal
 * (`tests/unit/broadcasts/domain/cascade-cancellation-reason.test.ts`), because
 * members may not import this module's Domain directly.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */

export const CASCADE_CANCELLATION_REASONS = [
  'originator_member_deleted',
  'gdpr_erasure_request',
  'pdpa_deletion_request',
] as const;

export type CascadeCancellationReason = (typeof CASCADE_CANCELLATION_REASONS)[number];
