/**
 * Verifies migration 0209 (member-number schema) applied correctly
 * against live Neon. Run AFTER `pnpm db:migrate`.
 *
 * Asserts the exact surface from design doc §5/§6:
 *   - tenant_member_sequences + tenant_member_settings tables exist
 *   - members.member_number is NOT NULL integer
 *   - per-tenant UNIQUE index + positive CHECK constraint
 *   - RLS ENABLED + FORCED on both new tables
 *   - SweCham seeds: settings prefix 'SCCM' + sequence last_number >= 0
 *   - DB backstops reject non-positive member_number
 *
 * Runs against the live Neon Singapore DB via tests/integration-setup.ts.
 * The module-level `db` singleton connects as the Neon owner role
 * (rolbypassrls = TRUE), so direct reads of the RLS-protected seed rows
 * succeed without a runInTenant wrapper — exactly what migration
 * verification needs.
 *
 * NOTE: this project's `db.execute(sql`...`)` (drizzle-orm/postgres-js)
 * returns the rows array DIRECTLY (no `.rows` wrapper) — matching the
 * sibling migration-schema.test.ts. Do not switch to `result.rows`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

describe('migration 0209 — post-apply verification', () => {
  it('tenant_member_sequences table exists with expected columns', async () => {
    const rows = await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'tenant_member_sequences'
      ORDER BY ordinal_position
    `);
    const cols = rows.map((r) => (r as { column_name: string }).column_name);
    expect(cols).toContain('tenant_id');
    expect(cols).toContain('last_number');
    expect(cols).toContain('updated_at');
  });

  it('tenant_member_settings table exists with expected columns', async () => {
    const rows = await db.execute(sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'tenant_member_settings'
      ORDER BY ordinal_position
    `);
    const cols = rows.map((r) => (r as { column_name: string }).column_name);
    expect(cols).toContain('tenant_id');
    expect(cols).toContain('member_number_prefix');
    expect(cols).toContain('created_at');
    expect(cols).toContain('updated_at');
  });

  it('members.member_number column is NOT NULL integer', async () => {
    const rows = await db.execute(sql`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'members'
        AND column_name = 'member_number'
    `);
    expect(rows).toHaveLength(1);
    const r = rows[0] as { data_type: string; is_nullable: string };
    expect(r.data_type).toBe('integer');
    expect(r.is_nullable).toBe('NO');
  });

  it('every members row has a non-null member_number (backfill complete)', async () => {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*)::int                                       AS total,
        COUNT(*) FILTER (WHERE member_number IS NULL)::int  AS nulls
      FROM members
    `);
    const r = rows[0] as { total: number; nulls: number };
    expect(r.nulls).toBe(0);
    // Sanity: the live integration DB must hold at least the seeded members.
    expect(r.total).toBeGreaterThan(0);
  });

  it('member_numbers are contiguous 1..N per REAL tenant with no duplicates', async () => {
    // Scope to REAL (migrated) tenants. Throwaway INTEGRATION tenants
    // (`test-…` / `__test…`) are created post-migration by other suites'
    // raw `members` inserts using `nextSeedMemberNumber()` (a HIGH 900_000+
    // value, intentionally non-contiguous — it bypasses the allocator so a
    // fixture and a real createMember can share a throwaway tenant without
    // colliding; see tests/.../seed-member-number.ts). Those tenants are NOT
    // what migration 0209 backfilled, and a leaked one (an interrupted run's
    // afterAll that didn't fire) would false-fail this all-tenant invariant
    // on the shared dev Neon. The migration-verification assertion is about
    // the real backfill, so exclude the throwaway test tenants.
    const rows = await db.execute(sql`
      SELECT tenant_id,
             COUNT(*)::int                     AS cnt,
             MIN(member_number)::int           AS minn,
             MAX(member_number)::int           AS maxn,
             COUNT(DISTINCT member_number)::int AS distinctn
      FROM members
      WHERE tenant_id NOT LIKE 'test-%'
        AND LEFT(tenant_id, 2) <> '__'
      GROUP BY tenant_id
    `);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const r = row as {
        tenant_id: string;
        cnt: number;
        minn: number;
        maxn: number;
        distinctn: number;
      };
      // 1..N: smallest is 1, largest equals the count, all distinct.
      expect(r.minn, `tenant ${r.tenant_id} min`).toBe(1);
      expect(r.maxn, `tenant ${r.tenant_id} max == count`).toBe(r.cnt);
      expect(r.distinctn, `tenant ${r.tenant_id} no duplicates`).toBe(r.cnt);
    }
  });

  it('members_tenant_member_number_uniq unique index exists', async () => {
    const rows = await db.execute(sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'members'
        AND indexname = 'members_tenant_member_number_uniq'
    `);
    expect(rows).toHaveLength(1);
    const r = rows[0] as { indexdef: string };
    expect(r.indexdef).toContain('tenant_id');
    expect(r.indexdef).toContain('member_number');
  });

  it('members_member_number_positive CHECK constraint exists', async () => {
    const rows = await db.execute(sql`
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_name = 'members'
        AND constraint_name = 'members_member_number_positive'
        AND constraint_type = 'CHECK'
    `);
    expect(rows).toHaveLength(1);
  });

  it('tenant_member_sequences RLS is FORCE enabled', async () => {
    const rows = await db.execute(sql`
      SELECT relrowsecurity::boolean AS rls, relforcerowsecurity::boolean AS force_rls
      FROM pg_class
      WHERE relname = 'tenant_member_sequences'
    `);
    expect(rows).toHaveLength(1);
    const r = rows[0] as { rls: boolean; force_rls: boolean };
    expect(r.rls).toBe(true);
    expect(r.force_rls).toBe(true);
  });

  it('tenant_member_settings RLS is FORCE enabled', async () => {
    const rows = await db.execute(sql`
      SELECT relrowsecurity::boolean AS rls, relforcerowsecurity::boolean AS force_rls
      FROM pg_class
      WHERE relname = 'tenant_member_settings'
    `);
    expect(rows).toHaveLength(1);
    const r = rows[0] as { rls: boolean; force_rls: boolean };
    expect(r.rls).toBe(true);
    expect(r.force_rls).toBe(true);
  });

  it('swecham seed row in tenant_member_settings has prefix SCCM', async () => {
    // DB owner bypasses RLS; direct query is safe for migration verification.
    const rows = await db.execute(sql`
      SELECT member_number_prefix
      FROM tenant_member_settings
      WHERE tenant_id = 'swecham'
    `);
    expect(rows).toHaveLength(1);
    const r = rows[0] as { member_number_prefix: string };
    expect(r.member_number_prefix).toBe('SCCM');
  });

  it('swecham seed row in tenant_member_sequences has last_number == MAX(member_number)', async () => {
    const seqRows = await db.execute(sql`
      SELECT last_number FROM tenant_member_sequences WHERE tenant_id = 'swecham'
    `);
    expect(seqRows).toHaveLength(1);
    const last = (seqRows[0] as { last_number: number }).last_number;
    expect(typeof last).toBe('number');
    expect(last).toBeGreaterThanOrEqual(0);

    const maxRows = await db.execute(sql`
      SELECT MAX(member_number)::int AS m FROM members WHERE tenant_id = 'swecham'
    `);
    const maxN = (maxRows[0] as { m: number | null }).m;
    // Counter seeded to the current high-water mark (next member = last + 1).
    expect(last).toBe(maxN ?? 0);
  });

  it('DB backstop: INSERT member_number = 0 violates positive CHECK', async () => {
    await expect(
      db.execute(sql`
        INSERT INTO members (tenant_id, member_id, company_name, country,
          plan_id, plan_year, member_number)
        VALUES ('__test_impossible__', gen_random_uuid(), 'X', 'TH',
          '__x__', 2024, 0)
      `),
    ).rejects.toThrow();
  });

  it('DB backstop: INSERT member_number = -1 violates positive CHECK', async () => {
    await expect(
      db.execute(sql`
        INSERT INTO members (tenant_id, member_id, company_name, country,
          plan_id, plan_year, member_number)
        VALUES ('__test_impossible__', gen_random_uuid(), 'X', 'TH',
          '__x__', 2024, -1)
      `),
    ).rejects.toThrow();
  });

  // ── prefix-format CHECK negatives ────────────────────────────────────────
  // The `member_number_prefix ~ '^[A-Z][A-Z0-9]{0,7}$'` CHECK on
  // tenant_member_settings is the SOLE guard against a malformed prefix
  // reaching formatMemberNumber → the Thai tax-invoice buyer block. Each
  // malformed prefix must be rejected by the DB (SQLSTATE 23514). The CHECK
  // fires before any row is written, so a throwaway tenant_id needs no cleanup
  // on the reject path; a defensive DELETE in afterAll covers an accidental
  // pass (which would itself fail the test above).
  const PREFIX_CHECK_TENANT = '__test_prefix_check__';

  afterAll(async () => {
    await db
      .execute(
        sql`DELETE FROM tenant_member_settings WHERE tenant_id = ${PREFIX_CHECK_TENANT}`,
      )
      .catch(() => {});
  });

  it.each([
    ['lowercase (sccm)', 'sccm'],
    ['leading digit (9X)', '9X'],
    ['too long >8 chars (TOOLONGPREFIX)', 'TOOLONGPREFIX'],
    ['empty string ()', ''],
  ])(
    'DB backstop: INSERT member_number_prefix %s violates format CHECK',
    async (_label, prefix) => {
      await expect(
        db.execute(sql`
          INSERT INTO tenant_member_settings (tenant_id, member_number_prefix)
          VALUES (${PREFIX_CHECK_TENANT}, ${prefix})
        `),
      ).rejects.toThrow();
    },
  );

  it('DB backstop: a VALID prefix (SCCM) is accepted then cleaned up (positive control)', async () => {
    // Proves the CHECK is not rejecting everything — a well-formed prefix passes.
    await db.execute(sql`
      INSERT INTO tenant_member_settings (tenant_id, member_number_prefix)
      VALUES (${PREFIX_CHECK_TENANT}, 'SCCM')
    `);
    const rows = await db.execute(sql`
      SELECT member_number_prefix FROM tenant_member_settings
      WHERE tenant_id = ${PREFIX_CHECK_TENANT}
    `);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { member_number_prefix: string }).member_number_prefix).toBe('SCCM');
    await db.execute(
      sql`DELETE FROM tenant_member_settings WHERE tenant_id = ${PREFIX_CHECK_TENANT}`,
    );
  });
});
