/**
 * 108 PR-D T045 (US4 / FR-027, FR-030, FR-052, FR-053) — per-contact marketing
 * opt-out on live Neon.
 *
 * Part 1 — schema (migrations 0294 + 0295): the three nullable columns exist,
 * the correlated CHECK refuses a partial row, the source CHECK refuses an
 * unknown source, the partial index that backs the audience query exists, and
 * the two audit enum values are registered.
 *
 * Part 2 — `setMarketingOptOutInTx` + cross-tenant isolation is added in the
 * next TDD cycle (the repo method does not exist yet).
 *
 * Simulated emails only — no real PII.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { errorChainMessage } from '@/lib/db-errors';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

async function expectRefused(p: Promise<unknown>, token: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected the statement to be refused').toBeDefined();
  expect(errorChainMessage(caught)).toMatch(token);
}

describe('108 PR-D — contact marketing opt-out columns (migrations 0294 + 0295)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let contactId: string;
  const planId = `mkt-${randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPortalPlan(tenant.ctx.slug, admin.userId, planId);
    const seeded = await seedPortalMemberWithContact(tenant, planId);
    contactId = seeded.contactId;
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('0294: the three nullable opt-out columns exist with the data-model types', async () => {
    const rows = await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'contacts'
        AND column_name IN ('marketing_opt_out_at', 'marketing_opt_out_source', 'marketing_opt_out_by_user_id')
      ORDER BY column_name
    `);
    const cols = rows.map((r) => r as { column_name: string; data_type: string; is_nullable: string });
    expect(cols.map((c) => c.column_name)).toEqual([
      'marketing_opt_out_at',
      'marketing_opt_out_by_user_id',
      'marketing_opt_out_source',
    ]);
    expect(cols.every((c) => c.is_nullable === 'YES')).toBe(true);
    expect(cols.map((c) => c.data_type)).toEqual([
      'timestamp with time zone',
      'uuid',
      'text',
    ]);
  });

  it('0294: a fully-set opt-out row is accepted and reads back', async () => {
    await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`
        UPDATE contacts
        SET marketing_opt_out_at = now(),
            marketing_opt_out_source = 'staff',
            marketing_opt_out_by_user_id = ${admin.userId}::uuid
        WHERE contact_id = ${contactId}::uuid
      `),
    );
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`
        SELECT marketing_opt_out_source AS source, marketing_opt_out_by_user_id AS by_user_id
        FROM contacts WHERE contact_id = ${contactId}::uuid
      `),
    );
    const row = rows[0] as { source: string; by_user_id: string };
    expect(row.source).toBe('staff');
    expect(row.by_user_id).toBe(admin.userId);
    // Reset to "receives" for the next cases.
    await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`
        UPDATE contacts
        SET marketing_opt_out_at = NULL, marketing_opt_out_source = NULL, marketing_opt_out_by_user_id = NULL
        WHERE contact_id = ${contactId}::uuid
      `),
    );
  });

  it('0294: the correlated CHECK refuses a partial row (timestamp without source/actor)', async () => {
    await expectRefused(
      runInTenant(tenant.ctx, (tx) =>
        tx.execute(sql`
          UPDATE contacts SET marketing_opt_out_at = now()
          WHERE contact_id = ${contactId}::uuid
        `),
      ),
      /contacts_marketing_opt_out_correlated/,
    );
  });

  it('0294: the correlated CHECK refuses source + actor without a timestamp', async () => {
    await expectRefused(
      runInTenant(tenant.ctx, (tx) =>
        tx.execute(sql`
          UPDATE contacts
          SET marketing_opt_out_source = 'self', marketing_opt_out_by_user_id = ${admin.userId}::uuid
          WHERE contact_id = ${contactId}::uuid
        `),
      ),
      /contacts_marketing_opt_out_correlated/,
    );
  });

  it('0294: the source CHECK refuses anything but staff | self', async () => {
    await expectRefused(
      runInTenant(tenant.ctx, (tx) =>
        tx.execute(sql`
          UPDATE contacts
          SET marketing_opt_out_at = now(),
              marketing_opt_out_source = 'import',
              marketing_opt_out_by_user_id = ${admin.userId}::uuid
          WHERE contact_id = ${contactId}::uuid
        `),
      ),
      /contacts_marketing_opt_out_source_check/,
    );
  });

  it('0294: the partial recipients index exists on (tenant_id, member_id, contact_id) WHERE live AND not opted out', async () => {
    const rows = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'contacts'
        AND indexname = 'contacts_marketing_recipients_idx'
    `);
    expect(rows).toHaveLength(1);
    const def = (rows[0] as { indexdef: string }).indexdef;
    expect(def).toMatch(/\(tenant_id, member_id, contact_id\)/);
    expect(def).toMatch(/removed_at IS NULL/);
    expect(def).toMatch(/marketing_opt_out_at IS NULL/);
  });

  it('0295: both contact-marketing audit event types are registered', async () => {
    const rows = await db.execute(sql`
      SELECT enumlabel FROM pg_enum e
      JOIN pg_type t ON e.enumtypid = t.oid
      WHERE t.typname = 'audit_event_type'
        AND enumlabel IN ('contact_marketing_opted_out', 'contact_marketing_opted_in')
      ORDER BY enumlabel
    `);
    expect(rows.map((r) => (r as { enumlabel: string }).enumlabel)).toEqual([
      'contact_marketing_opted_in',
      'contact_marketing_opted_out',
    ]);
  });
});
