/**
 * F9 US6 (T090/T091) — `GdprArchiveSource` port.
 *
 * The read contract the GDPR archive builder needs to gather ONE member's
 * personal data across the five source modules + the audit subset. The
 * Infrastructure adapter (`sources/gdpr-archive-source-adapter.ts`) binds it,
 * calling each module's PUBLIC BARREL (never a deep import — Principle III) and
 * applying the pure `buildMemberAuditSubset` redaction (`gdpr-audit-subset.ts`).
 *
 * `gather` returns `null` when the subject member does not exist for the tenant
 * (truly-absent / cross-tenant / RLS miss) so the worker can mark the job
 * `failed` with `member_not_found`. An ARCHIVED member still resolves (FR-032a:
 * portability persists after archival); only a non-existent member is null.
 *
 * Pure types — no framework/ORM imports (Principle III).
 */
import type { TenantContext } from '@/modules/tenants';
import type { GdprAuditEntry } from '../gdpr-audit-subset';

/** One invoice: serialisable record fields + its PDF bytes (null if undocumented). */
export interface GdprInvoiceEntry {
  /** Serialisable invoice fields (number, dates, amounts, status, lines). */
  readonly record: Record<string, unknown>;
  /** The invoice PDF for the archive, or null when the invoice has no PDF. */
  readonly pdf: { readonly filename: string; readonly bytes: Uint8Array } | null;
}

/** The full per-member data bundle the zip builder serialises. */
export interface GdprMemberData {
  readonly subjectMemberId: string;
  readonly profile: Record<string, unknown>;
  readonly contacts: readonly Record<string, unknown>[];
  readonly invoices: readonly GdprInvoiceEntry[];
  readonly events: readonly Record<string, unknown>[];
  readonly broadcasts: readonly Record<string, unknown>[];
  readonly auditEvents: readonly GdprAuditEntry[];
}

export interface GdprArchiveSource {
  gather(
    ctx: TenantContext,
    opts: { readonly subjectMemberId: string },
  ): Promise<GdprMemberData | null>;
}
