/**
 * BroadcastsContentScrubPort adapter — bridges F3 member erasure → F7
 * `scrubBroadcastContentForMember` (COMP-1 US2b, GDPR Art. 17 / PDPA §33).
 *
 * Single allowed F3 → F7 crossing point for the CONTENT redaction cascade
 * (the `broadcast_deliveries` tombstone runs in `eraseMember`'s atomic scrub
 * tx, not here). Imports F7's public barrel (`@/modules/broadcasts`)
 * — Constitution Principle III barrel-guard permits cross-module reads of
 * public exports. Internal F7 modules (`./application`, `./infrastructure`)
 * are NOT imported.
 *
 * Best-effort: the F7 use-case is never-throws (returns a typed `Result`),
 * but this adapter still wraps the call in try/catch so a throw at the
 * calling convention (e.g. a deps-factory failure) is translated to
 * `{ outcome: 'failed' }` + a logged error — the erasure proof records the
 * cascade as incomplete, never a silent swallow-to-no-op.
 */
import {
  scrubBroadcastContentForMember,
  makeScrubBroadcastContentForMemberDeps,
} from '@/modules/broadcasts';
import { logger } from '@/lib/logger';
import type { BroadcastsContentScrubPort } from '../../application/ports/broadcasts-content-scrub-port';

/**
 * No-op content-scrub adapter for tests that don't exercise the F7
 * boundary (`BroadcastsContentScrubPort` is required in production deps;
 * tests inject this stub instead of leaving the dep `undefined`).
 */
export const noopBroadcastsContentScrubAdapter: BroadcastsContentScrubPort = {
  async scrubContentForMember() {
    // The `'ok'` variant of the discriminated union REQUIRES both counts;
    // a no-op scrubbed/tombstoned nothing.
    return { outcome: 'ok', scrubbedCount: 0, tombstonedCount: 0 };
  },
};

export const f7BroadcastsContentScrubAdapter: BroadcastsContentScrubPort = {
  async scrubContentForMember(tenant, memberId, meta) {
    try {
      const deps = makeScrubBroadcastContentForMemberDeps(tenant.slug);
      const result = await scrubBroadcastContentForMember(deps, {
        tenant,
        memberId,
        // The delivery-tombstone count produced by the caller's ATOMIC
        // members-scrub tx (the tombstone moved out of this post-commit
        // step in the 2026-06-18 2nd /code-review fix). Threaded so the
        // single `broadcast_content_redacted` audit records both counts.
        tombstonedCount: meta.tombstonedCount,
        // Thread the erasure legal basis (Art. 17 / PDPA §33) into the F7
        // use-case so the `broadcast_content_redacted` audit records the
        // real reason instead of the archival default
        // (`'originator_member_deleted'`). `MemberErasureReason` is a strict
        // subset of the use-case's `ScrubContentReason`, so this widens
        // cleanly with no cast.
        reason: meta.reason,
        initiatedByUserId: meta.initiatedByUserId,
        requestId: meta.requestId,
      });
      if (!result.ok) {
        // F7 content scrub failure is non-fatal for the F3 erasure flow,
        // but the cascade completion proof MUST record it as incomplete —
        // log + return `outcome: 'failed'` (no swallow-to-no-op). Ops can
        // re-run the scrub via the erasure-cascade cleanup runbook.
        logger.error(
          {
            err: result.error.message,
            errKind: result.error.kind,
            tenantId: tenant.slug,
            memberId: memberId as string,
            cascade: 'f7_broadcast_content_scrub',
          },
          'members.erase.broadcasts_content_scrub_failed',
        );
        return { outcome: 'failed' };
      }
      return {
        outcome: 'ok',
        scrubbedCount: result.value.scrubbedCount,
        tombstonedCount: result.value.tombstonedCount,
      };
    } catch (e) {
      // Defensive: the use-case is never-throws, but a throw at the
      // calling convention (deps factory, etc.) must not break the
      // erasure flow — translate to `outcome: 'failed'` + log.
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          tenantId: tenant.slug,
          memberId: memberId as string,
          cascade: 'f7_broadcast_content_scrub',
        },
        'members.erase.broadcasts_content_scrub_failed',
      );
      return { outcome: 'failed' };
    }
  },
};
