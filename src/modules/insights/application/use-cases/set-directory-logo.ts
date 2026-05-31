/**
 * F9 US5 `setDirectoryLogo` / `removeDirectoryLogo` use-cases (T079 / FR-025a).
 *
 * Member-own / admin-any (manager read-only) logo control through a safe image
 * pipeline: size cap + declared-MIME allow-list (defence) → server re-encode +
 * EXIF strip (the actual-bytes allow-list) → PUBLIC blob upload of ONLY the
 * re-encoded image (the original is never served) → store URL on the listing +
 * audit `directory_listing_updated` with `logo_action: set | removed`.
 *
 * Application layer: no sharp/ORM imports (Constitution Principle III).
 */
import { runInTenant } from '@/lib/db';
import { ok, err, type Result } from '@/lib/result';
import { insightsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';
import { f9RetentionFor, type InsightsAuditPort } from '../ports/audit-port';
import type { DirectoryRepo } from '../ports/directory-repo';
import type { LogoContentType, LogoImagePort, LogoStorePort } from '../ports/logo-port';

export type LogoActorRole = 'admin' | 'manager' | 'member';

/** Max accepted upload size before re-encode (FR-025a ≤ 2 MB). */
export const MAX_LOGO_UPLOAD_BYTES = 2 * 1024 * 1024;

const ALLOWED_UPLOAD_MIME: ReadonlySet<string> = new Set<LogoContentType>([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export interface SetDirectoryLogoInput {
  readonly memberId: string;
  readonly bytes: Uint8Array;
  /** Client-declared MIME — validated as defence; sharp re-validates by content. */
  readonly declaredMime: string;
}

export interface DirectoryLogoMeta {
  readonly actorUserId: string;
  readonly actorRole: LogoActorRole;
  readonly actorMemberId: string | null;
  readonly requestId: string;
}

export interface SetDirectoryLogoDeps {
  readonly directoryRepo: DirectoryRepo;
  readonly image: LogoImagePort;
  readonly logoStore: LogoStorePort;
  readonly audit: InsightsAuditPort;
}

export type SetDirectoryLogoError =
  | 'forbidden'
  | 'too_large'
  | 'unsupported_format'
  | 'invalid_image'
  | 'member_not_found';

function authorizeMutation(meta: DirectoryLogoMeta, memberId: string): boolean {
  if (meta.actorRole === 'manager') return false;
  if (meta.actorRole === 'member') return meta.actorMemberId === memberId;
  return meta.actorRole === 'admin';
}

export async function setDirectoryLogo(
  input: SetDirectoryLogoInput,
  meta: DirectoryLogoMeta,
  ctx: TenantContext,
  deps: SetDirectoryLogoDeps,
): Promise<Result<{ readonly logoUrl: string }, SetDirectoryLogoError>> {
  if (!authorizeMutation(meta, input.memberId)) return err('forbidden');
  if (input.bytes.length > MAX_LOGO_UPLOAD_BYTES) return err('too_large');
  // Normalise the declared Content-Type before the allow-list check: a browser
  // (or proxy) may append parameters (`image/jpeg; charset=utf-8`) or vary case.
  // The byte-level `sharp` re-encode below is the authoritative format guard;
  // this string check is the cheap pre-filter and must not reject a valid type
  // over a harmless parameter. Essence = type/subtype, lower-cased.
  const declaredMime = input.declaredMime.split(';')[0]!.trim().toLowerCase();
  if (!ALLOWED_UPLOAD_MIME.has(declaredMime)) return err('unsupported_format');

  const reencoded = await deps.image.reencode(input.bytes);
  if (!reencoded.ok) {
    return err(
      reencoded.error.code === 'unsupported_format' ? 'unsupported_format' : 'invalid_image',
    );
  }

  // Upload ONLY the re-encoded bytes (original never served — FR-025a).
  const key = `directory-logos/${ctx.slug}/${input.memberId}`;
  const { url } = await deps.logoStore.putPublicLogo({
    key,
    body: reencoded.value.bytes,
    contentType: reencoded.value.contentType,
  });

  const outcome = await runInTenant(ctx, async (tx) => {
    const existing = await deps.directoryRepo.findByMemberIdInTx(tx, input.memberId);
    const set = await deps.directoryRepo.setLogoInTx(tx, input.memberId, url);
    if (set.memberNotFound) {
      return { state: 'member_not_found' as const, priorLogoUrl: null };
    }
    await deps.audit.recordInTx(tx, {
      tenantId: ctx.slug,
      requestId: meta.requestId,
      eventType: 'directory_listing_updated',
      actorUserId: meta.actorUserId,
      retentionYears: f9RetentionFor('directory_listing_updated'),
      summary: `directory logo set for member ${input.memberId}`,
      payload: {
        subject_member_id: input.memberId,
        listed: existing?.listed ?? false,
        changed_fields: ['logo'],
        logo_action: 'set',
      },
    });
    return { state: 'ok' as const, priorLogoUrl: existing?.logoUrl ?? null };
  });

  if (outcome.state === 'member_not_found') {
    // Roll back the just-uploaded orphan blob (best-effort).
    await deps.logoStore.deleteLogo(url).catch(() => {});
    return err('member_not_found');
  }
  // Delete the REPLACED logo blob so re-uploads don't leak orphans (each upload
  // gets a fresh `addRandomSuffix` URL, so the prior URL differs from the new one).
  if (outcome.priorLogoUrl !== null && outcome.priorLogoUrl !== url) {
    await deps.logoStore.deleteLogo(outcome.priorLogoUrl).catch(() => {});
  }
  insightsMetrics.directoryListingUpdated(ctx.slug);
  return ok({ logoUrl: url });
}

export interface RemoveDirectoryLogoDeps {
  readonly directoryRepo: DirectoryRepo;
  readonly logoStore: LogoStorePort;
  readonly audit: InsightsAuditPort;
}

export type RemoveDirectoryLogoError = 'forbidden' | 'member_not_found';

export async function removeDirectoryLogo(
  input: { readonly memberId: string },
  meta: DirectoryLogoMeta,
  ctx: TenantContext,
  deps: RemoveDirectoryLogoDeps,
): Promise<Result<void, RemoveDirectoryLogoError>> {
  if (!authorizeMutation(meta, input.memberId)) return err('forbidden');

  const outcome = await runInTenant(ctx, async (tx) => {
    const existing = await deps.directoryRepo.findByMemberIdInTx(tx, input.memberId);
    const set = await deps.directoryRepo.setLogoInTx(tx, input.memberId, null);
    if (set.memberNotFound) return { state: 'member_not_found' as const, priorUrl: null };
    await deps.audit.recordInTx(tx, {
      tenantId: ctx.slug,
      requestId: meta.requestId,
      eventType: 'directory_listing_updated',
      actorUserId: meta.actorUserId,
      retentionYears: f9RetentionFor('directory_listing_updated'),
      summary: `directory logo removed for member ${input.memberId}`,
      payload: {
        subject_member_id: input.memberId,
        listed: existing?.listed ?? false,
        changed_fields: ['logo'],
        logo_action: 'removed',
      },
    });
    return { state: 'ok' as const, priorUrl: existing?.logoUrl ?? null };
  });

  if (outcome.state === 'member_not_found') return err('member_not_found');
  // Delete the now-unreferenced blob (best-effort; the row no longer points at it).
  if (outcome.priorUrl !== null) await deps.logoStore.deleteLogo(outcome.priorUrl).catch(() => {});
  insightsMetrics.directoryListingUpdated(ctx.slug);
  return ok(undefined);
}
