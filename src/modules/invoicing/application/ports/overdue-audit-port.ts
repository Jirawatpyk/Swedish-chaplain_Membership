/**
 * T109 — Overdue-detected audit port (F4).
 *
 * A dedicated single-method port for `invoice_overdue_detected` emits
 * because:
 *   - The emit semantics are materially different from the general
 *     `AuditPort`: it uses `INSERT … ON CONFLICT DO NOTHING` backed
 *     by the `audit_log_overdue_once_per_day` partial unique index
 *     (migration 0021), whereas `AuditPort.emit` is a straight INSERT.
 *   - The return value (`true` = new row landed, `false` = dup
 *     swallowed) is informational for tests + metrics; the general
 *     `emit` signature returns `void`.
 *
 * Splitting keeps `AuditPort` clean for the 16 non-idempotent F4
 * event types and avoids a leaky abstraction where most callers
 * would ignore the return value.
 */

/** Fields the use-case supplies. `payload` is constructed by the adapter. */
export interface OverdueDetectedEvent {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly invoiceId: string;
  readonly memberId: string;
  /** Raw document number (e.g. "INV-2026-000001"), null for pre-issue bugs. */
  readonly documentNumber: string | null;
  /** Stored due_date on the invoice, YYYY-MM-DD. */
  readonly dueDate: string;
  /** Bangkok-local "today" at emit time, YYYY-MM-DD — for audit payload. */
  readonly bangkokLocalDate: string;
}

export interface OverdueAuditPort {
  /**
   * Emit `invoice_overdue_detected` for the given invoice on the
   * current Bangkok-local day. Returns `true` when a new row was
   * inserted; `false` when the partial unique index already has an
   * entry for (tenant, invoice, day) — i.e., this invoice was
   * already detected overdue earlier today.
   *
   * MUST NOT throw on duplicate; only genuine infra failures should
   * surface as rejected promises. Callers treat rejections as a
   * best-effort logging hiccup, not a read-path failure.
   */
  emitOverdueOnce(event: OverdueDetectedEvent): Promise<boolean>;
}
