/**
 * `DirectoryErasurePort` adapter — bridges F3 member erasure → F9
 * `eraseMemberInsightsFootprint` (directory listing + logo blob + the member's
 * own GDPR export artefacts; COMP-1 / GDPR Art. 17 / PDPA §33).
 *
 * Single allowed F3 → F9 crossing point for the directory cascade. Imports F9's
 * public barrel (`@/modules/insights`) — Constitution Principle III barrel-guard
 * permits cross-module reads of public exports. Internal F9 modules are NOT
 * imported.
 *
 * The insights footprint erase throws on any DB/blob failure; this adapter wraps
 * it so a throw becomes `{ outcome: 'failed' }` (+ a hygienic log — errKind only,
 * NEVER the raw message, which can embed a member's logo URL / SQL param PII).
 * A `'failed'` outcome flips the erasure cascade's `allCascadesClean` flag →
 * `member_erased` withheld → the US2d reconciler re-drives (idempotent +
 * re-drive-safe by construction).
 */
import { eraseMemberInsightsFootprint } from '@/modules/insights';
import { logger } from '@/lib/logger';
import type { DirectoryErasurePort } from '../../application/ports/directory-erasure-port';

/**
 * No-op directory-erasure adapter for tests that don't exercise the F9 boundary
 * (`DirectoryErasurePort` is required in production deps; tests inject this stub
 * rather than leaving the dep undefined). Erased nothing → clean 'ok'.
 */
export const noopDirectoryErasureAdapter: DirectoryErasurePort = {
  async eraseForMember() {
    return { outcome: 'ok' };
  },
};

export const directoryErasureAdapter: DirectoryErasurePort = {
  async eraseForMember(tenant, memberId, meta) {
    try {
      await eraseMemberInsightsFootprint(tenant, memberId as string);
      return { outcome: 'ok' };
    } catch (e) {
      logger.error(
        {
          // Forbidden-log hygiene: error CLASS name only, never the raw message
          // (it can embed the logo URL / SQL param values).
          errKind: e instanceof Error ? e.constructor.name : 'unknown',
          tenantId: tenant.slug,
          memberId: memberId as string,
          requestId: meta.requestId,
          cascade: 'f9_directory_erasure',
        },
        'members.erase.directory_erasure_failed',
      );
      return { outcome: 'failed' };
    }
  },
};
