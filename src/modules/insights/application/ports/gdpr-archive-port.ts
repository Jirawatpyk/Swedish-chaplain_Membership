/**
 * F9 US6 (T090/T092) — `GdprArchivePort`.
 *
 * The worker-facing port the `processExportJob` worker calls for a
 * `gdpr_member_archive` job. The Infrastructure adapter composes the gather
 * (`GdprArchiveSource`) + the deterministic zip builder, so the Application
 * worker stays free of cross-module + `fflate`/crypto imports (Principle III).
 *
 * Returns `member_not_found` when the subject member does not exist for the
 * tenant (FR-032a: an archived member still resolves; only a truly-absent /
 * cross-tenant member fails). No silent failure (FR-037) — the worker marks the
 * job `failed` with this code.
 */
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { Locale } from '@/i18n/config';

export interface BuildGdprArchiveResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface BuildArchiveForMemberOpts {
  readonly subjectMemberId: string;
  /** Requester's locale for the README (EN fallback) — FR-029. */
  readonly requesterLocale: Locale;
  /** ISO-8601 UTC generation instant (README + manifest). */
  readonly generatedAtIso: string;
}

export type GdprArchiveError = 'member_not_found';

export interface GdprArchivePort {
  buildArchiveForMember(
    ctx: TenantContext,
    opts: BuildArchiveForMemberOpts,
  ): Promise<Result<BuildGdprArchiveResult, GdprArchiveError>>;
}
