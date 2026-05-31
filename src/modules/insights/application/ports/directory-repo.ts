/**
 * F9 US5 `DirectoryRepo` Application port (T078).
 *
 * Owns the insights `directory_listings` table. Two read shapes:
 *   - `search` — staff browse of ALL members + their listing status (FR-024).
 *     Spans `directory_listings` (insights) + `members`/`contacts`/
 *     `membership_plans` (other modules) — the adapter issues a tenant-scoped
 *     raw-SQL JOIN over the *physical* tables (no cross-module TS import; same
 *     documented cross-module-SQL pattern as `member_timeline_v`). RLS on each
 *     base table enforces tenant isolation under `runInTenant`.
 *   - `listPublishedInTx` — the opt-in subset (`listed = true`, non-archived)
 *     with the live identity needed to build the E-Book / JSON (T080/T081).
 *
 * Writes (`upsertInTx`, `setLogoInTx`) thread `tx` from `runInTenant` so the
 * row + its audit event commit atomically (CLAUDE.md RLS gotcha).
 *
 * `tx: TenantTx` mirrors the other insights repo ports (e.g.
 * `InsightDismissalRepo`) — the type is re-exported from `@/lib/db` (the same
 * module the use-cases already import `runInTenant` from), so no ORM type leaks
 * into the use-cases (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import type { FieldVisibility } from '../../domain/directory-listing';

/** The insights-owned directory metadata stored per member. */
export interface DirectoryListingRecord {
  readonly memberId: string;
  readonly listed: boolean;
  readonly fieldVisibility: FieldVisibility;
  readonly industry: string | null;
  readonly description: string | null;
  readonly website: string | null;
  /**
   * Public Blob **URL** of the re-encoded logo (NOT a content-addressed key —
   * `setDirectoryLogo` stores the `put({access:'public', addRandomSuffix:true})`
   * URL here, which is not derivable from a key). The Drizzle adapter maps it
   * from the `logo_blob_key` DB column; this application field is named `logoUrl`
   * to match its true meaning (and `PublishedListing.logoUrl`). Contrast F4
   * invoicing's `logoBlobKey`, which genuinely is a private key.
   */
  readonly logoUrl: string | null;
  readonly locationCity: string | null;
  readonly locationCountry: string | null;
}

/** Mutable directory fields written by `updateDirectoryListing` (logo is separate). */
export interface DirectoryListingPatch {
  readonly listed: boolean;
  readonly fieldVisibility: FieldVisibility;
  readonly industry: string | null;
  readonly description: string | null;
  readonly website: string | null;
  readonly locationCity: string | null;
  readonly locationCountry: string | null;
}

export interface DirectorySearchFilter {
  /** Keyword across company name + listing industry + description (FR-024). */
  readonly q?: string;
  /** Structured tier filter — matches `membership_plans.plan_category`. */
  readonly tier?: string;
  readonly city?: string;
  /** ISO 3166-1 alpha-2 country (matches `members.country`). */
  readonly country?: string;
  /** Staff toggle: only members who have opted in. */
  readonly listedOnly?: boolean;
  readonly limit: number;
  readonly offset: number;
}

/** A staff search row: live member identity + the listing status (or null). */
export interface DirectorySearchRow {
  readonly memberId: string;
  readonly companyName: string;
  readonly status: string;
  readonly tier: string | null;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  /** null when the member has never created a directory_listings row. */
  readonly listing: DirectoryListingRecord | null;
}

/** A published-listing source row: live identity + the member's listing metadata. */
export interface PublishedSourceRow {
  readonly memberId: string;
  readonly companyName: string;
  readonly tier: string | null;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly listing: DirectoryListingRecord;
}

export interface DirectoryRepo {
  /** Read a member's listing row (insights' own table) inside the caller's tx. */
  findByMemberIdInTx(
    tx: TenantTx,
    memberId: string,
  ): Promise<DirectoryListingRecord | null>;

  /** Standalone read of a member's listing row (pre-fills the settings form). */
  findByMemberId(
    ctx: TenantContext,
    memberId: string,
  ): Promise<DirectoryListingRecord | null>;

  /**
   * Upsert the listing metadata + visibility. Returns `memberNotFound` when no
   * such member exists in the tenant (checked before the write so no failing
   * statement poisons the caller's tx). Does NOT touch the logo blob key (use
   * `setLogoInTx`).
   */
  upsertInTx(
    tx: TenantTx,
    memberId: string,
    patch: DirectoryListingPatch,
  ): Promise<{ readonly memberNotFound: boolean }>;

  /**
   * Set or clear the logo URL (FR-025a). Upserts the row if absent; returns
   * `memberNotFound` when no such member exists in the tenant (checked before
   * the write so no failing FK statement poisons the caller's tx).
   */
  setLogoInTx(
    tx: TenantTx,
    memberId: string,
    logoUrl: string | null,
  ): Promise<{ readonly memberNotFound: boolean }>;

  /** Staff search across all members + listing status (FR-024). */
  search(
    ctx: TenantContext,
    filter: DirectorySearchFilter,
  ): Promise<{ readonly rows: readonly DirectorySearchRow[]; readonly total: number }>;

  /**
   * The opt-in published subset (`listed = true`, non-archived members) with
   * live identity, for E-Book / JSON generation (T080/T081). Threaded in the
   * worker's tx so the artefact reflects a consistent snapshot.
   */
  listPublishedInTx(tx: TenantTx): Promise<readonly PublishedSourceRow[]>;
}
