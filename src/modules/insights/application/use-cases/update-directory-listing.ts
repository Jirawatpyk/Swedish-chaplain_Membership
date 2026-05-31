/**
 * F9 US5 `updateDirectoryListing` use-case (T078 / FR-025, FR-028).
 *
 * A member controls their OWN directory listing (visibility + per-field
 * exposure + directory metadata); an admin may edit ANY member's listing
 * on-behalf. The read-only-on-finance manager role and members editing
 * someone else's listing are `forbidden`. Default-private / email-default-hidden
 * is the Domain policy (`DEFAULT_FIELD_VISIBILITY`); this use-case persists
 * whatever toggles the actor submits, after sanitising the visibility map to
 * the fixed field set and validating the website scheme + description cap.
 *
 * Emits `directory_listing_updated` atomically with the write, carrying the
 * changed top-level field NAMES (never values — FR-036 / research R12). The
 * logo is set/removed via a separate action (`setDirectoryLogo`, T079) so this
 * use-case never touches the blob key.
 *
 * Application layer: orchestrates Domain + ports via `runInTenant`; no ORM
 * imports (Constitution Principle III).
 */
import { runInTenant } from '@/lib/db';
import { ok, err, type Result } from '@/lib/result';
import { insightsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';
import {
  DIRECTORY_FIELDS,
  isDescriptionWithinCap,
  isFieldVisible,
  isValidDirectoryWebsite,
  sanitizeFieldVisibility,
  type FieldVisibility,
} from '../../domain/directory-listing';
import { f9RetentionFor, type InsightsAuditPort } from '../ports/audit-port';
import type {
  DirectoryListingPatch,
  DirectoryListingRecord,
  DirectoryRepo,
} from '../ports/directory-repo';

export type DirectoryActorRole = 'admin' | 'manager' | 'member';

export interface UpdateDirectoryListingInput {
  readonly memberId: string;
  readonly listed: boolean;
  readonly fieldVisibility: FieldVisibility;
  readonly industry: string | null;
  readonly description: string | null;
  readonly website: string | null;
  readonly locationCity: string | null;
  readonly locationCountry: string | null;
}

export interface UpdateDirectoryListingMeta {
  readonly actorUserId: string;
  readonly actorRole: DirectoryActorRole;
  /** The acting member's own member_id (null for staff). Gates member self-edit. */
  readonly actorMemberId: string | null;
  readonly requestId: string;
}

export interface UpdateDirectoryListingDeps {
  readonly directoryRepo: DirectoryRepo;
  readonly audit: InsightsAuditPort;
}

export type UpdateDirectoryListingError =
  | 'forbidden'
  | 'invalid_website'
  | 'description_too_long'
  | 'member_not_found';

/** Trim then collapse empty strings to null (a cleared form field sends ''). */
function normalize(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function visibilityEqual(a: FieldVisibility, b: FieldVisibility): boolean {
  return DIRECTORY_FIELDS.every(
    (f) => isFieldVisible(a, f) === isFieldVisible(b, f),
  );
}

function computeChangedFields(
  existing: DirectoryListingRecord | null,
  patch: DirectoryListingPatch,
): string[] {
  const changed: string[] = [];
  if (existing === null || existing.listed !== patch.listed) {
    changed.push('listed');
  }
  if (
    existing === null ||
    !visibilityEqual(existing.fieldVisibility, patch.fieldVisibility)
  ) {
    changed.push('field_visibility');
  }
  if (existing === null || existing.industry !== patch.industry) {
    changed.push('industry');
  }
  if (existing === null || existing.description !== patch.description) {
    changed.push('description');
  }
  if (existing === null || existing.website !== patch.website) {
    changed.push('website');
  }
  if (existing === null || existing.locationCity !== patch.locationCity) {
    changed.push('location_city');
  }
  if (existing === null || existing.locationCountry !== patch.locationCountry) {
    changed.push('location_country');
  }
  return changed;
}

export async function updateDirectoryListing(
  input: UpdateDirectoryListingInput,
  meta: UpdateDirectoryListingMeta,
  ctx: TenantContext,
  deps: UpdateDirectoryListingDeps,
): Promise<Result<void, UpdateDirectoryListingError>> {
  // RBAC (FR-025): members edit their own listing only; admins edit any; the
  // read-only-on-finance manager role may view the directory but not mutate it.
  if (meta.actorRole === 'manager') return err('forbidden');
  if (meta.actorRole === 'member' && meta.actorMemberId !== input.memberId) {
    return err('forbidden');
  }

  const website = normalize(input.website);
  if (website !== null && !isValidDirectoryWebsite(website)) {
    return err('invalid_website');
  }
  const description = normalize(input.description);
  if (description !== null && !isDescriptionWithinCap(description)) {
    return err('description_too_long');
  }

  const patch: DirectoryListingPatch = {
    listed: input.listed,
    // Defence-in-depth: drop any key outside the fixed directory field set.
    fieldVisibility: sanitizeFieldVisibility(input.fieldVisibility),
    industry: normalize(input.industry),
    description,
    website,
    locationCity: normalize(input.locationCity),
    locationCountry: normalize(input.locationCountry),
  };

  const result = await runInTenant(ctx, async (tx) => {
    const existing = await deps.directoryRepo.findByMemberIdInTx(
      tx,
      input.memberId,
    );
    const upserted = await deps.directoryRepo.upsertInTx(
      tx,
      input.memberId,
      patch,
    );
    if (upserted.memberNotFound) return 'member_not_found' as const;

    await deps.audit.recordInTx(tx, {
      tenantId: ctx.slug,
      requestId: meta.requestId,
      eventType: 'directory_listing_updated',
      actorUserId: meta.actorUserId,
      retentionYears: f9RetentionFor('directory_listing_updated'),
      summary: `directory listing updated for member ${input.memberId} (listed=${patch.listed})`,
      payload: {
        subject_member_id: input.memberId,
        listed: patch.listed,
        changed_fields: computeChangedFields(existing, patch),
      },
    });
    return 'ok' as const;
  });

  if (result === 'member_not_found') return err('member_not_found');
  insightsMetrics.directoryListingUpdated(ctx.slug);
  return ok(undefined);
}

// --- read (pre-fill the settings form) --------------------------------------

export interface GetDirectoryListingDeps {
  readonly directoryRepo: DirectoryRepo;
}

export type GetDirectoryListingError = 'forbidden';

/**
 * Read a member's directory listing (member: own only; staff: any). Returns
 * `null` when the member has no listing row yet (the form falls back to the
 * default-private/email-hidden defaults).
 */
export async function getDirectoryListing(
  input: { readonly memberId: string },
  meta: {
    readonly actorRole: DirectoryActorRole;
    readonly actorMemberId: string | null;
  },
  ctx: TenantContext,
  deps: GetDirectoryListingDeps,
): Promise<Result<DirectoryListingRecord | null, GetDirectoryListingError>> {
  if (meta.actorRole === 'member' && meta.actorMemberId !== input.memberId) {
    return err('forbidden');
  }
  const record = await deps.directoryRepo.findByMemberId(ctx, input.memberId);
  return ok(record);
}
