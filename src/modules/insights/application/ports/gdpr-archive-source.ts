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

/** A category whose export was capped at the most-recent N records. */
export type GdprTruncatableCategory = 'invoices' | 'events' | 'broadcasts' | 'auditEvents' | 'changeRequests';

/**
 * F114 (FR-014 / FR-029 / FR-030) — one change request in the requester's
 * history: the proposed / seen values with their outcomes, the reviewer's
 * reason AND note (FR-014: both are the subject's personal data), the
 * decider as the ORGANISATION — the archive never names a staff member.
 */
export interface GdprChangeRequestEntry {
  readonly id: string;
  readonly scope: string;
  readonly state: string;
  readonly outcome: string | null;
  readonly withdrawnReason: string | null;
  readonly submittedAt: string;
  readonly submittedBy: { readonly contactId: string; readonly displayName: string };
  readonly decidedAt: string | null;
  readonly decidedBy: 'organisation';
  readonly decisionReason: string | null;
  readonly decisionNote: string | null;
  readonly fields: readonly {
    readonly key: string;
    readonly target: string;
    readonly seen: unknown;
    readonly proposed: unknown;
    readonly outcome: string | null;
    readonly appliedAt: string | null;
    readonly affectsTaxDocuments: boolean;
  }[];
}

/**
 * Completeness signal (FR-037 — "no export may silently fail/mislead"). The
 * GDPR path applies defensive per-category caps and keeps the NEWEST records;
 * when a cap is hit the OLDEST data is dropped. `truncatedCategories` records
 * which categories were capped so the archive (README + manifest) can disclose
 * the partial export instead of presenting a checksummed archive as complete.
 * Empty array ⇒ the archive is a complete copy. (code-review max F9 — finding #5)
 */
export interface GdprCompleteness {
  readonly truncatedCategories: readonly GdprTruncatableCategory[];
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
  /** F114 — the requester's change-request history (FR-029-scoped when the requester is a linked contact). */
  readonly changeRequests: readonly GdprChangeRequestEntry[];
  /**
   * Per-category truncation disclosure. Optional for backward-compatible test
   * fixtures (absent ⇒ treated as complete); the adapter always populates it.
   */
  readonly completeness?: GdprCompleteness;
}

export interface GdprArchiveSource {
  gather(
    ctx: TenantContext,
    opts: {
      readonly subjectMemberId: string;
      /**
       * F114 (FR-029) — the user who asked for the export. When they are one
       * of the member's linked contacts the change-request history is scoped
       * to what THEY may see (their own + company-level); an on-behalf
       * request from staff exports the whole member's history. Absent ⇒
       * whole history (a legacy job row).
       */
      readonly requestedByUserId?: string;
    },
  ): Promise<GdprMemberData | null>;
}
