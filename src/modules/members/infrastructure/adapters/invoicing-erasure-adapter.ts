/**
 * `InvoicingErasurePort` adapter — bridges F3 member erasure → F4
 * `discardMemberDraftInvoices` (COMP-1 / GDPR Art. 17 / PDPA §33).
 *
 * Single allowed F3 → F4 crossing point for the erasure cascade. Imports F4's
 * public barrel (`@/modules/invoicing`) — Constitution Principle III barrel-guard
 * permits cross-module use of public exports; internal F4 modules are NOT
 * imported, and this adapter issues no SQL of its own against F4's tables.
 *
 * `discardMemberDraftInvoices` is contractually never-throws and reports
 * per-row counts, so this adapter's job is (a) to build F4's deps, (b) to map a
 * non-zero `failedCount` to the port's `'failed'` outcome, and (c) to defend
 * against a pathological throw from the deps construction itself.
 */
import {
  discardMemberDraftInvoices,
  makeDeleteInvoiceDraftDeps,
} from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import type { InvoicingErasurePort } from '../../application/ports/invoicing-erasure-port';

/**
 * No-op invoicing-erasure adapter for tests that don't exercise the F4 boundary
 * (`InvoicingErasurePort` is required in production deps; tests inject this stub
 * rather than leaving the dep undefined — mirrors `noopDirectoryErasureAdapter`).
 * Discarded nothing → clean 'ok'.
 */
export const noopInvoicingErasureAdapter: InvoicingErasurePort = {
  async discardDraftsForMember() {
    return { outcome: 'ok', discardedCount: 0 };
  },
};

/**
 * Rollout-gated OFF variant, selected by `members-deps.ts` when
 * `FEATURE_ERASURE_DISCARD_DRAFTS` is false (the default).
 *
 * Reports a clean `'ok'` BY DESIGN. A disabled cascade is not a failed one:
 * returning `'failed'` here would flip `allCascadesClean` in `eraseMember`,
 * permanently withhold the `member_erased` completion proof, and leave the US2d
 * reconciler re-driving the same member forever.
 *
 * Distinct from `noopInvoicingErasureAdapter` (a test stub) precisely so the
 * production skip is visible in logs — a silent no-op on a compliance path is
 * indistinguishable from "the member had no drafts".
 */
export const disabledInvoicingErasureAdapter: InvoicingErasurePort = {
  async discardDraftsForMember(tenant, memberId, meta) {
    logger.info(
      {
        tenantId: tenant.slug,
        memberId: memberId as string,
        requestId: meta.requestId,
        cascade: 'f4_draft_discard',
      },
      'members.erase.invoicing_draft_discard_disabled',
    );
    return { outcome: 'ok', discardedCount: 0 };
  },
};

export const invoicingErasureAdapter: InvoicingErasurePort = {
  async discardDraftsForMember(tenant, memberId, meta) {
    try {
      // `makeDeleteInvoiceDraftDeps` supplies exactly the { invoiceRepo, audit }
      // pair this use-case needs (its deps shape is a superset-free match), with
      // NO external tx: this is a POST-COMMIT cascade, so each discard opens its
      // own short tenant-scoped transaction and one row's rollback cannot poison
      // another's.
      const result = await discardMemberDraftInvoices(
        makeDeleteInvoiceDraftDeps(tenant.slug),
        {
          tenantId: tenant.slug,
          memberId: memberId as string,
          actorUserId: meta.actorUserId,
          requestId: meta.requestId,
        },
      );

      if (result.failedCount > 0) {
        logger.error(
          {
            tenantId: tenant.slug,
            memberId: memberId as string,
            requestId: meta.requestId,
            discardedCount: result.discardedCount,
            skippedCount: result.skippedCount,
            failedCount: result.failedCount,
            cascade: 'f4_draft_discard',
          },
          'members.erase.invoicing_draft_discard_partial',
        );
        return { outcome: 'failed', discardedCount: result.discardedCount };
      }

      return { outcome: 'ok', discardedCount: result.discardedCount };
    } catch (e) {
      logger.error(
        {
          // Forbidden-log hygiene: error CLASS name only, never the raw message
          // (it can embed SQL parameter values / member PII).
          errKind: e instanceof Error ? e.constructor.name : 'unknown',
          tenantId: tenant.slug,
          memberId: memberId as string,
          requestId: meta.requestId,
          cascade: 'f4_draft_discard',
        },
        'members.erase.invoicing_draft_discard_threw',
      );
      return { outcome: 'failed', discardedCount: 0 };
    }
  },
};
