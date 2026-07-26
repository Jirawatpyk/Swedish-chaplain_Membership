/**
 * `InvoicingErasurePort` — F3 member erasure → F4 invoicing draft discard
 * (COMP-1 / GDPR Art. 17 / PDPA §33).
 *
 * The single allowed F3 → F4 crossing point for the erasure cascade. F4 owns
 * the `invoices` table, so members must never DELETE from it directly (the
 * Constitution Principle III violation caught on this branch at Task 9) — the
 * adapter delegates to F4's barrel-exported `discardMemberDraftInvoices`, which
 * in turn composes F4's own `deleteInvoiceDraft`.
 *
 * **Retention policy** (see the F4 use-case for the full rationale): DISCARDS
 * `draft` invoices, RETAINS `issued` and beyond. This reaches EVERY draft the
 * member holds — auto-renewal, admin-created manual, and F6 event-fee alike
 * (member + `status='draft'` and nothing else) — because a manual draft holds
 * the same PII an Art.17 erasure exists to remove. A draft carries no §87
 * sequence number and no statutory retention duty (Art. 5(1)(c) minimisation +
 * Art. 17 apply); an issued document is retained under the Thai RD §87/3
 * legal-obligation carve-out, Art. 17(3)(b). Nothing already issued is deleted,
 * voided, or altered.
 *
 * Best-effort / never-throws: a `'failed'` outcome flips the erasure cascade's
 * `allCascadesClean` flag → `member_erased` is withheld → the US2d reconciler
 * re-drives (the underlying scan-and-discard is idempotent — a re-drive
 * re-scans and finds only what survived).
 */
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';

export interface InvoicingErasurePort {
  discardDraftsForMember(
    tenant: TenantContext,
    memberId: MemberId,
    meta: { readonly actorUserId: string; readonly requestId: string },
  ): Promise<{
    readonly outcome: 'ok' | 'failed';
    /**
     * Drafts actually removed. Surfaced onto the `member_erased` DPO audit
     * payload so an auditor can see the erasure's invoicing footprint at a
     * glance; the authoritative per-document trail is F4's own
     * `invoice_draft_deleted` rows.
     */
    readonly discardedCount: number;
  }>;
}
