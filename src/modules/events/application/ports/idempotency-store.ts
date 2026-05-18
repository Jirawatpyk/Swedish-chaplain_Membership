/**
 * T028 — `IdempotencyStore` Application port (F6).
 *
 * Writes (and optionally probes) idempotency receipts to
 * `eventcreate_idempotency_receipts` (migration 0134). Used by:
 *   - Webhook receiver (Phase 3 T052): tries to insert a receipt with
 *     `source = 'eventcreate_webhook'` + the X-Request-ID. ON CONFLICT
 *     DO NOTHING — if the conflict fires, this delivery is a duplicate
 *     replay → emit `webhook_duplicate_rejected` audit + return HTTP 409.
 *   - CSV importer (Phase 7 T094): tries to insert a receipt per row
 *     with `source = 'eventcreate_csv'` + SHA-256 of the canonical row
 *     bytes. ON CONFLICT DO NOTHING — silent skip (no error log; the
 *     row is counted under `rowsAlreadyImported`).
 *
 * Why `tryInsert` returns a `wasFresh` flag rather than a separate
 * `exists()` probe: the project's idempotency pattern is single-roundtrip
 * INSERT ... ON CONFLICT DO NOTHING — adding a SELECT probe would
 * introduce a TOCTOU race window between probe and insert. The flag
 * tells the caller whether the row was inserted now (`wasFresh=true`,
 * proceed with processing) or already existed (`wasFresh=false`, treat
 * as duplicate).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import type { TenantId } from '@/modules/members';
import type { IdempotencySource } from '../../domain/value-objects/source';

export interface TryInsertReceiptInput {
  readonly tenantId: TenantId;
  readonly source: IdempotencySource;
  readonly requestId: string;
  /**
   * Optional explicit TTL — defaults to NOW() + 7 days at the DB level
   * if undefined per migration 0134. Callers can pass a custom TTL for
   * test fixtures or specialised cases.
   */
  readonly ttlExpiresAt?: Date;
}

export interface TryInsertReceiptResult {
  /**
   * TRUE = row was inserted now (this is the first/fresh occurrence —
   * caller should proceed with processing).
   * FALSE = row already existed (duplicate — caller should short-circuit
   * to the duplicate audit + 409 response or silent-skip).
   */
  readonly wasFresh: boolean;
  /**
   * On `wasFresh=false`, the timestamp of the original successful
   * insertion (read from the conflicting row). Used in the
   * `webhook_duplicate_rejected` audit payload per
   * contracts/audit-port.md § 1.
   */
  readonly originalProcessedAt: Date | null;
}

export type IdempotencyStoreError =
  | { readonly kind: 'db_error'; readonly message: string };

export interface DeleteReceiptInput {
  readonly tenantId: TenantId;
  readonly source: IdempotencySource;
  readonly requestId: string;
}

export interface IdempotencyStore {
  /**
   * Atomic insert-or-skip. Idempotent: re-issuing the same call after
   * the row exists is a no-op that returns `{wasFresh:false}`.
   */
  tryInsert(
    input: TryInsertReceiptInput,
  ): Promise<Result<TryInsertReceiptResult, IdempotencyStoreError>>;

  /**
   * Orphan-receipt cleanup for the F6.1 self-heal path. Used ONLY when
   * `tryInsert` returned `wasFresh:false` AND the matching
   * `event_registrations` row was deleted (manual cleanup, F6 PII
   * erasure, dev teardown, pseudonymise sweep race). The use-case
   * deletes the orphan receipt + re-runs the row through the normal
   * processing pipeline so the registration lands fresh. Idempotent:
   * deleting a row that does not exist is a no-op.
   */
  delete(
    input: DeleteReceiptInput,
  ): Promise<Result<void, IdempotencyStoreError>>;
}
