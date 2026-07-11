/**
 * `DirectoryErasurePort` — F3 member erasure → F9 insights directory footprint
 * erasure (COMP-1 / GDPR Art. 17 / PDPA §33).
 *
 * The single allowed F3 → F9 crossing point for the directory cascade: erases
 * the member's `directory_listings` row (member-authored PII) AND the public
 * logo blob (a publicly-fetchable artefact). Both are insights-owned, so the
 * adapter delegates to the insights barrel (`eraseMemberDirectoryFootprint`).
 *
 * Best-effort / never-throws: a `'failed'` outcome flips the erasure cascade's
 * `allCascadesClean` flag → `member_erased` is withheld → the US2d reconciler
 * re-drives (the underlying operation is idempotent + re-drive-safe).
 */
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';

export interface DirectoryErasurePort {
  eraseForMember(
    tenant: TenantContext,
    memberId: MemberId,
    meta: { readonly actorUserId: string; readonly requestId: string },
  ): Promise<{ readonly outcome: 'ok' | 'failed' }>;
}
