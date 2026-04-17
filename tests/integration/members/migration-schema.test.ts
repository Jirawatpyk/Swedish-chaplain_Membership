/**
 * T007 — Migration schema integration test.
 *
 * Asserts that migration 0009 (members + contacts) + 0010 (audit_log
 * F3 extension) have landed with the exact surface spec'd in
 * `specs/005-members-contacts/data-model.md`:
 *   - members + contacts tables exist
 *   - pg_trgm extension is enabled
 *   - All required indexes are present
 *   - RLS is ENABLED + FORCED on both tables
 *   - 23 new audit_event_type enum values are registered
 *   - last_activity_at trigger is installed
 *   - member_status enum is created
 *
 * This test runs against the live Neon Singapore DB via
 * `tests/integration/setup.ts`. It is a cheap regression guard — if
 * a future migration accidentally drops an index or disables RLS,
 * this test goes red.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

describe('F3 migration schema (T007)', () => {
  it('members + contacts tables exist', async () => {
    const rows = await db.execute(sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename IN ('members', 'contacts')
      ORDER BY tablename
    `);
    const names = rows.map((r) => (r as { tablename: string }).tablename);
    expect(names).toEqual(['contacts', 'members']);
  });

  it('pg_trgm extension is enabled', async () => {
    const rows = await db.execute(sql`
      SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'
    `);
    expect(rows).toHaveLength(1);
  });

  it('RLS is ENABLED + FORCED on members', async () => {
    const rows = await db.execute(sql`
      SELECT relrowsecurity::boolean AS rls, relforcerowsecurity::boolean AS force_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'members'
    `);
    expect(rows).toHaveLength(1);
    const r = rows[0] as { rls: boolean; force_rls: boolean };
    expect(r.rls).toBe(true);
    expect(r.force_rls).toBe(true);
  });

  it('RLS is ENABLED + FORCED on contacts', async () => {
    const rows = await db.execute(sql`
      SELECT relrowsecurity::boolean AS rls, relforcerowsecurity::boolean AS force_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'contacts'
    `);
    expect(rows).toHaveLength(1);
    const r = rows[0] as { rls: boolean; force_rls: boolean };
    expect(r.rls).toBe(true);
    expect(r.force_rls).toBe(true);
  });

  it('tenant-isolation RLS policies are installed on both tables', async () => {
    const rows = await db.execute(sql`
      SELECT tablename, policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('members', 'contacts')
      ORDER BY tablename
    `);
    const tuples = rows.map((r) => {
      const row = r as { tablename: string; policyname: string };
      return `${row.tablename}.${row.policyname}`;
    });
    expect(tuples).toContain('members.tenant_isolation_on_members');
    expect(tuples).toContain('contacts.tenant_isolation_on_contacts');
  });

  it('all required btree + GIN + partial-unique indexes exist', async () => {
    const rows = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('members', 'contacts', 'audit_log')
      ORDER BY indexname
    `);
    const names = new Set(
      rows.map((r) => (r as { indexname: string }).indexname),
    );
    // members
    expect(names).toContain('members_tenant_status_plan_idx');
    expect(names).toContain('members_tenant_year_idx');
    expect(names).toContain('members_tenant_last_activity_idx');
    expect(names).toContain('members_company_name_trgm_gin');
    // contacts
    expect(names).toContain('contacts_tenant_member_idx');
    expect(names).toContain('contacts_tenant_email_uniq');
    expect(names).toContain('contacts_one_primary_per_member');
    expect(names).toContain('contacts_name_trgm_gin');
    // audit_log F3 timeline accelerator
    expect(names).toContain('audit_log_member_id_idx');
  });

  it('member_status enum has exactly 3 values', async () => {
    const rows = await db.execute(sql`
      SELECT enumlabel FROM pg_enum e
      JOIN pg_type t ON e.enumtypid = t.oid
      WHERE t.typname = 'member_status'
      ORDER BY e.enumsortorder
    `);
    const labels = rows.map((r) => (r as { enumlabel: string }).enumlabel);
    expect(labels).toEqual(['active', 'inactive', 'archived']);
  });

  it('23 new F3 audit_event_type values are registered', async () => {
    const expected = [
      'member_created',
      'member_updated',
      'member_plan_changed',
      'member_primary_contact_changed',
      'member_status_changed',
      'member_archived',
      'member_undeleted',
      'contact_created',
      'contact_updated',
      'contact_removed',
      'member_self_updated',
      'member_self_update_forbidden',
      'member_cross_tenant_probe',
      'plan_bundle_changed',
      'member_contact_email_changed',
      'user_sessions_revoked',
      'email_verification_sent',
      'email_change_notification_sent_to_old_address',
      'member_email_change_reverted',
      'email_verification_resent',
      'email_dispatch_failed',
      'invitation_bounced',
      'bulk_action_rate_limit_exceeded',
    ];
    const rows = await db.execute(sql`
      SELECT enumlabel FROM pg_enum e
      JOIN pg_type t ON e.enumtypid = t.oid
      WHERE t.typname = 'audit_event_type'
    `);
    const present = new Set(
      rows.map((r) => (r as { enumlabel: string }).enumlabel),
    );
    for (const label of expected) {
      expect(present.has(label), `missing audit event type: ${label}`).toBe(
        true,
      );
    }
  });

  it('last_activity_at denorm trigger is installed on audit_log', async () => {
    const rows = await db.execute(sql`
      SELECT trigger_name FROM information_schema.triggers
      WHERE event_object_table = 'audit_log'
        AND trigger_name = 'audit_log_bump_member_last_activity'
    `);
    expect(rows).toHaveLength(1);
  });
});
