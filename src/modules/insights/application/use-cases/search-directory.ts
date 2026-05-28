/**
 * F9 US5 `searchDirectory` use-case (T078 / FR-024).
 *
 * Staff-facing search over ALL members + their directory-listing status.
 * Keyword `q` matches company name + listing industry + description; tier and
 * location (city/country) are structured filters (FR-024). Staff-only — admin
 * and the read-only-on-finance manager role may browse; members are `forbidden`
 * (members manage only their own listing via `updateDirectoryListing`).
 *
 * Numbered pagination (`page`/`pageSize`) with a total count for a
 * jump-to-page admin table, mirroring the F3 members directory. No audit event
 * is emitted (a list browse is not a per-member PII read — FR-036 audits member
 * detail views + exports, which have their own events).
 *
 * Application layer: no ORM imports (Constitution Principle III).
 */
import { ok, err, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { FieldVisibility } from '../../domain/directory-listing';
import type { DirectoryRepo, DirectorySearchFilter } from '../ports/directory-repo';

export type SearchDirectoryActorRole = 'admin' | 'manager' | 'member';

export interface SearchDirectoryInput {
  readonly q?: string;
  readonly tier?: string;
  readonly city?: string;
  readonly country?: string;
  readonly listedOnly?: boolean;
  /** 1-based page number (default 1). */
  readonly page?: number;
  /** Rows per page (1–100, default 50). */
  readonly pageSize?: number;
}

export interface SearchDirectoryMeta {
  readonly actorUserId: string;
  readonly actorRole: SearchDirectoryActorRole;
  readonly requestId: string;
}

export interface SearchDirectoryDeps {
  readonly directoryRepo: DirectoryRepo;
}

export type SearchDirectoryError = 'forbidden';

/** A row in the staff directory table (listing status surfaced for management). */
export interface DirectorySearchItem {
  readonly memberId: string;
  readonly companyName: string;
  readonly status: string;
  readonly tier: string | null;
  readonly listed: boolean;
  readonly fieldVisibility: FieldVisibility;
  readonly industry: string | null;
  readonly locationCity: string | null;
  readonly locationCountry: string | null;
  readonly hasLogo: boolean;
  readonly contactName: string | null;
}

export interface SearchDirectoryResult {
  readonly items: readonly DirectorySearchItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export async function searchDirectory(
  input: SearchDirectoryInput,
  meta: SearchDirectoryMeta,
  ctx: TenantContext,
  deps: SearchDirectoryDeps,
): Promise<Result<SearchDirectoryResult, SearchDirectoryError>> {
  // FR-024 — the internal directory is staff-only.
  if (meta.actorRole === 'member') return err('forbidden');

  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(
    Math.max(1, Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE)),
    MAX_PAGE_SIZE,
  );

  const filter: DirectorySearchFilter = {
    limit: pageSize,
    offset: (page - 1) * pageSize,
    ...(input.q !== undefined && input.q.trim() !== '' ? { q: input.q.trim() } : {}),
    ...(input.tier !== undefined && input.tier !== '' ? { tier: input.tier } : {}),
    ...(input.city !== undefined && input.city.trim() !== ''
      ? { city: input.city.trim() }
      : {}),
    ...(input.country !== undefined && input.country !== ''
      ? { country: input.country }
      : {}),
    ...(input.listedOnly === true ? { listedOnly: true } : {}),
  };

  const { rows, total } = await deps.directoryRepo.search(ctx, filter);

  const items: DirectorySearchItem[] = rows.map((r) => ({
    memberId: r.memberId,
    companyName: r.companyName,
    status: r.status,
    tier: r.tier,
    listed: r.listing?.listed ?? false,
    fieldVisibility: r.listing?.fieldVisibility ?? {},
    industry: r.listing?.industry ?? null,
    locationCity: r.listing?.locationCity ?? null,
    locationCountry: r.listing?.locationCountry ?? null,
    hasLogo: r.listing?.logoUrl != null,
    contactName: r.contactName,
  }));

  return ok({ items, total, page, pageSize });
}
