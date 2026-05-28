/**
 * F9 US5 `DirectoryRepo` Drizzle adapter (T078).
 *
 * Binds the tenant at construction and threads the caller's `tx` from
 * `runInTenant` — NEVER the global `db` (CLAUDE.md RLS gotcha) for the write
 * paths. `search` / `listPublishedInTx` issue a tenant-scoped raw-SQL JOIN over
 * the *physical* tables `members` / `contacts` / `membership_plans` +
 * `directory_listings`: this is the same documented cross-module-SQL pattern as
 * the shipped `member_timeline_v` (no cross-module TS import of another
 * module's schema). RLS + FORCE on every base table enforces tenant isolation
 * for the querying `chamber_app` role under `runInTenant` (Principle I).
 *
 * The insights-owned `directory_listings` writes use the Drizzle query builder
 * + the insights schema (its own table). `upsertInTx` checks member existence
 * with a guarded raw SELECT *before* writing, so a non-existent member yields
 * `memberNotFound` without a failing FK statement poisoning the caller's tx.
 */
import { eq, sql, type SQL } from 'drizzle-orm';
import { runInTenant, type TenantTx } from '@/lib/db';
import { sanitizeFieldVisibility } from '../../domain/directory-listing';
import type {
  DirectoryListingPatch,
  DirectoryListingRecord,
  DirectoryRepo,
  DirectorySearchFilter,
  DirectorySearchRow,
  PublishedSourceRow,
} from '../../application/ports/directory-repo';
import { directoryListings } from '../db/schema-insights';
import type { TenantContext } from '@/modules/tenants';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Escape LIKE metacharacters so a literal `%`/`_`/`\` in `q` matches literally. */
function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
}

interface SearchRawRow {
  readonly member_id: string;
  readonly company_name: string;
  readonly status: string;
  readonly tier: string | null;
  readonly contact_first_name: string | null;
  readonly contact_last_name: string | null;
  readonly contact_email: string | null;
  readonly listed: boolean | null;
  readonly field_visibility: unknown;
  readonly industry: string | null;
  readonly description: string | null;
  readonly website: string | null;
  readonly logo_blob_key: string | null;
  readonly location_city: string | null;
  readonly location_country: string | null;
  readonly total_count: number;
}

type PublishedRawRow = Omit<SearchRawRow, 'total_count' | 'listed'>;

function contactName(first: string | null, last: string | null): string | null {
  const name = `${first ?? ''} ${last ?? ''}`.trim();
  return name === '' ? null : name;
}

function toListingRecord(
  row: SearchRawRow | PublishedRawRow,
  memberId: string,
  listed: boolean,
): DirectoryListingRecord {
  return {
    memberId,
    listed,
    fieldVisibility: sanitizeFieldVisibility(row.field_visibility),
    industry: row.industry,
    description: row.description,
    website: row.website,
    logoBlobKey: row.logo_blob_key,
    locationCity: row.location_city,
    locationCountry: row.location_country,
  };
}

export function makeDrizzleDirectoryRepo(tenantId: string): DirectoryRepo {
  return {
    async findByMemberIdInTx(
      tx: TenantTx,
      memberId: string,
    ): Promise<DirectoryListingRecord | null> {
      if (!UUID_RE.test(memberId)) return null;
      const rows = await tx
        .select()
        .from(directoryListings)
        .where(eq(directoryListings.memberId, memberId))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        memberId: row.memberId,
        listed: row.listed,
        fieldVisibility: sanitizeFieldVisibility(row.fieldVisibility),
        industry: row.industry,
        description: row.description,
        website: row.website,
        logoBlobKey: row.logoBlobKey,
        locationCity: row.locationCity,
        locationCountry: row.locationCountry,
      };
    },

    async upsertInTx(
      tx: TenantTx,
      memberId: string,
      patch: DirectoryListingPatch,
    ): Promise<{ readonly memberNotFound: boolean }> {
      if (!UUID_RE.test(memberId)) return { memberNotFound: true };
      // Existence check BEFORE the write so a missing member never fires an FK
      // violation that would poison the caller's tx. RLS scopes to the tenant.
      const existing = (await tx.execute(
        sql`SELECT 1 AS ok FROM members WHERE member_id = ${memberId}::uuid LIMIT 1`,
      )) as unknown as Array<{ ok: number }>;
      if (existing.length === 0) return { memberNotFound: true };

      const now = new Date();
      await tx
        .insert(directoryListings)
        .values({
          tenantId,
          memberId,
          listed: patch.listed,
          fieldVisibility: patch.fieldVisibility,
          industry: patch.industry,
          description: patch.description,
          website: patch.website,
          locationCity: patch.locationCity,
          locationCountry: patch.locationCountry,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [directoryListings.tenantId, directoryListings.memberId],
          set: {
            listed: patch.listed,
            fieldVisibility: patch.fieldVisibility,
            industry: patch.industry,
            description: patch.description,
            website: patch.website,
            locationCity: patch.locationCity,
            locationCountry: patch.locationCountry,
            updatedAt: now,
          },
        });
      return { memberNotFound: false };
    },

    async setLogoInTx(
      tx: TenantTx,
      memberId: string,
      logoBlobKey: string | null,
    ): Promise<void> {
      const now = new Date();
      await tx
        .insert(directoryListings)
        .values({
          tenantId,
          memberId,
          listed: false,
          fieldVisibility: {},
          logoBlobKey,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [directoryListings.tenantId, directoryListings.memberId],
          set: { logoBlobKey, updatedAt: now },
        });
    },

    async search(
      ctx: TenantContext,
      filter: DirectorySearchFilter,
    ): Promise<{ readonly rows: readonly DirectorySearchRow[]; readonly total: number }> {
      return runInTenant(ctx, async (tx) => {
        // Exclude archived members from the directory management view.
        const conds: SQL[] = [sql`m.status <> 'archived'`];
        if (filter.q !== undefined && filter.q !== '') {
          const like = likeTerm(filter.q);
          conds.push(
            sql`(m.company_name ILIKE ${like} OR dl.industry ILIKE ${like} OR dl.description ILIKE ${like})`,
          );
        }
        if (filter.tier !== undefined) conds.push(sql`mp.plan_category = ${filter.tier}`);
        if (filter.city !== undefined) {
          conds.push(sql`lower(dl.location_city) = lower(${filter.city})`);
        }
        if (filter.country !== undefined) {
          conds.push(sql`dl.location_country = ${filter.country}`);
        }
        if (filter.listedOnly === true) conds.push(sql`dl.listed = true`);

        const whereSql = conds.reduce<SQL>(
          (acc, c, i) => (i === 0 ? c : sql`${acc} AND ${c}`),
          sql``,
        );

        const rows = (await tx.execute(sql`
          SELECT
            m.member_id::text                       AS member_id,
            m.company_name                          AS company_name,
            m.status                                AS status,
            (mp.plan_name->>'en')                   AS tier,
            c.first_name                            AS contact_first_name,
            c.last_name                             AS contact_last_name,
            c.email                                 AS contact_email,
            dl.listed                               AS listed,
            dl.field_visibility                     AS field_visibility,
            dl.industry                             AS industry,
            dl.description                          AS description,
            dl.website                              AS website,
            dl.logo_blob_key                        AS logo_blob_key,
            dl.location_city                        AS location_city,
            dl.location_country                     AS location_country,
            (count(*) OVER ())::int                 AS total_count
          FROM members m
          LEFT JOIN directory_listings dl
            ON dl.tenant_id = m.tenant_id AND dl.member_id = m.member_id
          LEFT JOIN membership_plans mp
            ON mp.tenant_id = m.tenant_id AND mp.plan_id = m.plan_id AND mp.plan_year = m.plan_year
          LEFT JOIN contacts c
            ON c.tenant_id = m.tenant_id AND c.member_id = m.member_id
               AND c.is_primary = true AND c.removed_at IS NULL
          WHERE ${whereSql}
          ORDER BY m.company_name ASC, m.member_id ASC
          LIMIT ${filter.limit} OFFSET ${filter.offset}
        `)) as unknown as SearchRawRow[];

        const mapped: DirectorySearchRow[] = rows.map((r) => ({
          memberId: r.member_id,
          companyName: r.company_name,
          status: r.status,
          tier: r.tier,
          contactName: contactName(r.contact_first_name, r.contact_last_name),
          contactEmail: r.contact_email,
          // A NULL `listed` means the LEFT JOIN found no directory_listings row
          // (listed is NOT NULL when a row exists).
          listing: r.listed === null ? null : toListingRecord(r, r.member_id, r.listed),
        }));

        return { rows: mapped, total: rows[0]?.total_count ?? 0 };
      });
    },

    async listPublishedInTx(tx: TenantTx): Promise<readonly PublishedSourceRow[]> {
      const rows = (await tx.execute(sql`
        SELECT
          m.member_id::text       AS member_id,
          m.company_name          AS company_name,
          m.status                AS status,
          (mp.plan_name->>'en')   AS tier,
          c.first_name            AS contact_first_name,
          c.last_name             AS contact_last_name,
          c.email                 AS contact_email,
          dl.field_visibility     AS field_visibility,
          dl.industry             AS industry,
          dl.description          AS description,
          dl.website              AS website,
          dl.logo_blob_key        AS logo_blob_key,
          dl.location_city        AS location_city,
          dl.location_country     AS location_country
        FROM directory_listings dl
        JOIN members m
          ON m.tenant_id = dl.tenant_id AND m.member_id = dl.member_id
             AND m.status <> 'archived'
        LEFT JOIN membership_plans mp
          ON mp.tenant_id = m.tenant_id AND mp.plan_id = m.plan_id AND mp.plan_year = m.plan_year
        LEFT JOIN contacts c
          ON c.tenant_id = m.tenant_id AND c.member_id = m.member_id
             AND c.is_primary = true AND c.removed_at IS NULL
        WHERE dl.listed = true
        ORDER BY m.company_name ASC, m.member_id ASC
      `)) as unknown as PublishedRawRow[];

      return rows.map((r) => ({
        memberId: r.member_id,
        companyName: r.company_name,
        tier: r.tier,
        contactName: contactName(r.contact_first_name, r.contact_last_name),
        contactEmail: r.contact_email,
        listing: toListingRecord(r, r.member_id, true),
      }));
    },
  };
}
