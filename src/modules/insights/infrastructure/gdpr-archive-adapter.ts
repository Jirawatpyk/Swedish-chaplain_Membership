/**
 * F9 US6 (T090/T092) — `GdprArchivePort` adapter.
 *
 * Composes the gather (`gdprArchiveSourceAdapter`) + the deterministic zip
 * builder (`buildGdprArchiveBytes`) behind the single worker-facing port. Kept
 * OUT of `insights-deps.ts` (like the directory artefact adapter) so App-Router
 * pages importing the barrel never pull `fflate` + the source-module barrels
 * into their bundle — only the `process-export-jobs` cron imports this.
 */
import { ok, err, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type {
  BuildArchiveForMemberOpts,
  BuildGdprArchiveResult,
  GdprArchiveError,
  GdprArchivePort,
} from '../application/ports/gdpr-archive-port';
import { gdprArchiveSourceAdapter } from './sources/gdpr-archive-source-adapter';
import { buildGdprArchiveBytes } from './sources/gdpr-archive-zip';

export function makeGdprArchiveAdapter(tenantName: string): GdprArchivePort {
  return {
    async buildArchiveForMember(
      ctx: TenantContext,
      opts: BuildArchiveForMemberOpts,
    ): Promise<Result<BuildGdprArchiveResult, GdprArchiveError>> {
      const data = await gdprArchiveSourceAdapter.gather(ctx, {
        subjectMemberId: opts.subjectMemberId,
      });
      if (data === null) return err('member_not_found');

      const { bytes, contentType } = buildGdprArchiveBytes(data, {
        tenantName,
        generatedAtIso: opts.generatedAtIso,
        requesterLocale: opts.requesterLocale,
      });
      return ok({ bytes, contentType });
    },
  };
}
