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
import type {
  ChangeRequestOutcome,
  ChangeRequestScope,
  ChangeRequestState,
  FieldOutcome,
  ProposableFieldKey,
  ProposedFieldTarget,
  ProposedValue,
  WithdrawnReason,
} from '@/modules/members';

/** One invoice: serialisable record fields + its PDF bytes (null if undocumented). */
export interface GdprInvoiceEntry {
  /** Serialisable invoice fields (number, dates, amounts, status, lines). */
  readonly record: Record<string, unknown>;
  /** The invoice PDF for the archive, or null when the invoice has no PDF. */
  readonly pdf: { readonly filename: string; readonly bytes: Uint8Array } | null;
}

/** A category whose export was capped at the most-recent N records. */
export type GdprTruncatableCategory =
  | 'invoices'
  | 'events'
  | 'broadcasts'
  | 'broadcastImages'
  | 'broadcastVersions'
  | 'auditEvents'
  | 'changeRequests';

/**
 * F114 (FR-014 / FR-029 / FR-030) — one change request in the requester's
 * history: the proposed / seen values with their outcomes, the reviewer's
 * reason AND note (FR-014: both are the subject's personal data), the
 * decider as the ORGANISATION — the archive never names a staff member.
 */
export interface GdprChangeRequestEntry {
  readonly id: string;
  readonly scope: ChangeRequestScope;
  readonly state: ChangeRequestState;
  readonly outcome: ChangeRequestOutcome | null;
  readonly withdrawnReason: WithdrawnReason | null;
  readonly submittedAt: string;
  /** `contactId` is null on a colleague's submission (Art. 15(4) — name only). */
  readonly submittedBy: { readonly contactId: string | null; readonly displayName: string };
  readonly decidedAt: string | null;
  readonly decidedBy: 'organisation';
  readonly decisionReason: string | null;
  readonly decisionNote: string | null;
  readonly fields: readonly GdprChangeRequestFieldEntry[];
}

/** One proposed field of the entry — the closed unions of the members Domain, ISO-8601 for the date (PR-3 polish, types S4). */
export interface GdprChangeRequestFieldEntry {
  readonly key: ProposableFieldKey;
  readonly target: ProposedFieldTarget;
  readonly seen: ProposedValue;
  readonly proposed: ProposedValue;
  readonly outcome: FieldOutcome | null;
  readonly appliedAt: string | null;
  readonly affectsTaxDocuments: boolean;
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
  /**
   * F119 R17 — every image uploaded for the member's E-Blasts, live AND
   * stamped; `blobUrl` only on a live image; no uploader (the archive never
   * names a user).
   */
  readonly broadcastImages: readonly Record<string, unknown>[];
  /**
   * F119 T083 (research R17) — the approval round of each of the member's
   * E-Blasts: the versions they were shown and their decisions, newest E-Blast
   * first. No unsent working copy, no staff identity (`authoredBy` is
   * `member` | `organisation`); after an erasure, the `[redacted]` sentinels.
   */
  readonly broadcastVersions: readonly Record<string, unknown>[];
  readonly auditEvents: readonly GdprAuditEntry[];
  /** The named contact a staff export was built for (README "Prepared for" + manifest); null otherwise. */
  readonly subjectContactId?: string | null;
  readonly subjectContactName?: string | null;
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
       * F114 (FR-029 / FR-014) — the user who asked for the export. When they
       * are one of the member's linked contacts the change-request history is
       * scoped to what THEY may see (their own requests in full + the
       * company-level ones as a non-submitter sees them). Any other
       * requester — staff on behalf, or absent (a legacy job row) — gets the
       * COMPANY-LEVEL history only: `company` / `mixed` requests with their
       * company fields and no reason / note, never a contact's own-field
       * request (the artefact may reach any contact, so it fails closed;
       * review round 1 of PR-2, C1).
       */
      readonly requestedByUserId?: string;
      /**
       * PDPA §30 / GDPR Art. 15 — staff answering ONE contact's access request
       * (incl. a former contact). The archive is built for that contact: their
       * own record in full, their own change requests + account activity when
       * they have a linked account, colleagues by name and role only. Must be
       * a contact of `subjectMemberId` — `gather` throws otherwise.
       */
      readonly subjectContactId?: string;
    },
  ): Promise<GdprMemberData | null>;
}
