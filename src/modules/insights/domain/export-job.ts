/**
 * F9 US5/US6 `ExportJob` domain state machine (T070 / data-model § 4, research R5).
 *
 * Async artefact generation (Directory E-Book, Directory JSON, GDPR archive,
 * over-cap audit export) is tracked by an `export_jobs` row whose `status`
 * follows a strict state machine. This module is the **reference model** for the
 * legal-transition graph + the helper API (`canTransition` / `isClaimable` /
 * `isTerminal` / `isStuckProcessing`) and backs the unit tests. **Runtime
 * enforcement lives in the repo**: every transition is a *guarded write*
 * (`WHERE id = $id AND status = $from`, see `export-job-repo.ts`), so an
 * illegal/concurrent transition simply updates 0 rows and the caller learns it
 * lost (the worker treats a 0-row claim/mark-ready as a lost race). The worker
 * additionally asserts `isClaimable` before claiming (defence-in-depth).
 *
 *   requested ──claim──▶ processing ──ok──▶ ready ──download──▶ delivered ──ttl──▶ expired
 *        │                   │                                       │
 *        └───────────────────┴─────────────── error ───────────────▶ failed
 *
 * The cron sweep additionally **reclaims** a `processing` job whose claim is
 * older than `STUCK_PROCESSING_TIMEOUT_MS` (critique E2 — a crashed worker must
 * not wedge a job forever).
 *
 * No imports — pure TypeScript (Constitution Principle III: Domain is
 * dependency-free). Hashing of the idempotency key happens in Infrastructure;
 * this module only builds the deterministic canonical input string.
 */

export const EXPORT_STATUSES = [
  'requested',
  'processing',
  'ready',
  'delivered',
  'expired',
  'failed',
] as const;

export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const EXPORT_KINDS = [
  'gdpr_member_archive',
  'directory_ebook',
  'directory_json',
  'audit_export',
] as const;

export type ExportKind = (typeof EXPORT_KINDS)[number];

/**
 * Claimed `processing` jobs older than this are considered stuck (crashed
 * worker) and reclaimed by the cron sweep. 10 minutes comfortably exceeds the
 * worst-case artefact build while bounding wedge time.
 */
export const STUCK_PROCESSING_TIMEOUT_MS = 10 * 60_000;

/** Default artefact + signed-link TTL (FR-030). 1 hour — short blast radius. */
export const DEFAULT_EXPORT_TTL_MS = 60 * 60_000;

const ALLOWED_TRANSITIONS: Record<ExportStatus, readonly ExportStatus[]> = {
  requested: ['processing', 'failed'],
  // `failed` covers both a build error and the current stuck-reclaim path
  // (`reclaimStuckInTx`). `requested` is RESERVED for a future *bounded-retry*
  // reclaim (re-queue instead of fail, critique E2) — not yet exercised by any
  // caller; today's reclaim always goes `processing → failed`.
  processing: ['ready', 'failed', 'requested'],
  ready: ['delivered', 'expired'],
  delivered: ['expired'],
  expired: [],
  failed: [],
};

export function canTransition(from: ExportStatus, to: ExportStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Terminal states never transition again. */
export function isTerminal(status: ExportStatus): boolean {
  return status === 'expired' || status === 'failed';
}

/** Only a `requested` job may be claimed by the worker. */
export function isClaimable(status: ExportStatus): boolean {
  return status === 'requested';
}

/**
 * Narrowing membership guard for an arbitrary string at a route/queue boundary:
 * true iff `kind` is one of the known `EXPORT_KINDS`. Takes `string` (not
 * `ExportKind`) so it actually narrows. (All current kinds are produced
 * asynchronously per FR-037; if a sync-only kind is ever added, express that
 * async distinction separately rather than overloading this membership check.)
 */
export function isExportKind(kind: string): kind is ExportKind {
  return (EXPORT_KINDS as readonly string[]).includes(kind);
}

/**
 * Whether a `processing` job's claim is older than the reclaim window. A null
 * claim timestamp (or a non-processing status) is never stuck. `claimedAtMs` is
 * the job's `updated_at` (the claim stamps it — there is no dedicated
 * `claimed_at` column). Pure helper backing the unit tests; the cron's actual
 * reclaim sweep is the repo's `listStuckProcessing` SQL on `updated_at`.
 */
export function isStuckProcessing(
  status: ExportStatus,
  claimedAtMs: number | null,
  nowMs: number,
  timeoutMs: number = STUCK_PROCESSING_TIMEOUT_MS,
): boolean {
  if (status !== 'processing' || claimedAtMs === null) return false;
  return nowMs - claimedAtMs > timeoutMs;
}

export interface ExportJobIdempotencyParts {
  readonly tenantId: string;
  readonly kind: ExportKind;
  readonly subjectMemberId: string | null;
  readonly requestedForPeriod: string | null;
}

/**
 * Deterministic canonical idempotency input (data-model § 4:
 * `hash(tenant_id, kind, subject_member_id, requested_for_period)`). Infra hashes
 * this string into `export_jobs.idempotency_key`. Null subject/period collapse to
 * an empty segment (a stable sentinel — never the literal "null"/"undefined").
 */
export function exportJobIdempotencyInput(
  parts: ExportJobIdempotencyParts,
): string {
  return [
    parts.tenantId,
    parts.kind,
    parts.subjectMemberId ?? '',
    parts.requestedForPeriod ?? '',
  ].join('|');
}
