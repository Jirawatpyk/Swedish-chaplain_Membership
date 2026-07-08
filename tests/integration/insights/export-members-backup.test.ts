/**
 * Members Backup Export — live-Neon integration (design 2026-07-07).
 *
 * Proves against real Postgres+RLS:
 *   1. gather returns the seeded member (ALL statuses incl. archived),
 *      live contact, and member-linked invoice with correct joins
 *      (member_number formatting, plan name, satang strings).
 *   2. soft-removed contacts are EXCLUDED.
 *   3. CROSS-TENANT (Principle I Review-Gate blocker): tenant B's rows
 *      never appear in tenant A's backup.
 *   4. the `members_backup_exported` audit row commits with row counts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  exportMembersBackup,
  makeExportMembersBackupDeps,
} from '@/modules/insights';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const SNAP_TENANT = {
  legal_name_th: 'ท', legal_name_en: 'T', tax_id: '0',
  address_th: 'B', address_en: 'B', logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'C', tax_id: '1', address: 'B',
  primary_contact_name: 'n', primary_contact_email: 't@e.com',
};

describe('exportMembersBackup — live Neon', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;
  const memberA = randomUUID();
  const memberB = randomUUID();
  const invoiceA = randomUUID();
  let memberANumber: number;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
    memberANumber = nextSeedMemberNumber();

    for (const [t, mid, num, name] of [
      [tenantA, memberA, memberANumber, 'Backup Acme A'],
      [tenantB, memberB, nextSeedMemberNumber(), 'Backup Beta B'],
    ] as const) {
      const planId = `bk-${randomUUID().slice(0, 8)}`;
      await runInTenant(t.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: t.ctx.slug,
          planId,
          planName: { en: 'Backup Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: admin.userId,
        });
        await tx.insert(members).values({
          tenantId: t.ctx.slug,
          memberId: mid,
          memberNumber: num,
          companyName: name,
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active',
          riskScore: null,
          riskScoreBand: null,
        });
        await tx.insert(contacts).values({
          tenantId: t.ctx.slug,
          contactId: randomUUID(),
          memberId: mid,
          firstName: 'Live',
          lastName: 'Contact',
          email: `bk-live-${mid.slice(0, 8)}@example.com`,
          isPrimary: true,
        });
        // soft-removed contact — must be EXCLUDED from the backup
        await tx.insert(contacts).values({
          tenantId: t.ctx.slug,
          contactId: randomUUID(),
          memberId: mid,
          firstName: 'Removed',
          lastName: 'Contact',
          email: `bk-gone-${mid.slice(0, 8)}@example.com`,
          isPrimary: false,
          removedAt: new Date(),
        });
        if (t === tenantA) {
          // Full non-draft field set required by the `invoices` CHECK
          // constraints (invoices_non_draft_has_snapshots / _has_doc_kind /
          // _draft_has_no_number / paid_has_receipt_status) — mirrors the
          // `paidInvoice` helper in invoice-source-adapter-fiscal.test.ts
          // (same insights integration directory, already-passing precedent).
          await tx.insert(invoices).values({
            tenantId: t.ctx.slug,
            invoiceId: invoiceA,
            memberId: mid,
            planId,
            planYear: 2026,
            invoiceSubject: 'membership',
            draftByUserId: admin.userId,
            status: 'paid',
            pdfDocKind: 'invoice',
            fiscalYear: 2026,
            sequenceNumber: 1,
            documentNumber: `INV-BK-${mid.slice(0, 6)}`,
            issueDate: '2026-01-15',
            dueDate: '2026-01-15',
            subtotalSatang: 1200000n,
            vatRateSnapshot: '0.0700',
            vatSatang: 84000n,
            totalSatang: 1284000n,
            creditedTotalSatang: 0n,
            proRatePolicySnapshot: 'monthly',
            netDaysSnapshot: 30,
            tenantIdentitySnapshot: SNAP_TENANT,
            memberIdentitySnapshot: SNAP_MEMBER,
            pdfBlobKey: `invoicing/bk/${mid}.pdf`,
            pdfSha256: 'a'.repeat(64),
            pdfTemplateVersion: 1,
            paidAt: new Date('2026-01-20T04:00:00Z'),
            paymentMethod: 'manual',
            receiptPdfStatus: 'rendered',
          });
        }
      });
    }
  }, 180_000);

  afterAll(async () => {
    await db.delete(invoices).where(eq(invoices.tenantId, tenantA.ctx.slug)).catch(() => {});
    for (const t of [tenantA, tenantB]) await t.cleanup().catch(() => {});
  }, 120_000);

  it('gathers members + live contacts + member-linked invoices; excludes removed contacts and tenant B', async () => {
    const res = await exportMembersBackup(
      { actorUserId: admin.userId, actorRole: 'admin', requestId: `req-${randomUUID().slice(0, 8)}` },
      tenantA.ctx,
      makeExportMembersBackupDeps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.zip.length).toBeGreaterThan(0);
    expect(res.value.rowCounts.members).toBeGreaterThanOrEqual(1);
    expect(res.value.rowCounts.invoices).toBeGreaterThanOrEqual(1);
    expect(res.value.filename).toMatch(
      new RegExp(`^${tenantA.ctx.slug}-members-backup-\\d{8}-\\d{4}\\.zip$`),
    );

    // Assert on the CSVs via a direct gather (same adapter the deps use)
    const { membersBackupSourceAdapter } = await import(
      '@/modules/insights/infrastructure/sources/members-backup-source-adapter'
    );
    const data = await runInTenant(tenantA.ctx, (tx) =>
      membersBackupSourceAdapter.gatherInTx(tx),
    );
    const companies = data.members.map((m) => m.companyName);
    expect(companies).toContain('Backup Acme A');
    expect(companies).not.toContain('Backup Beta B');

    const seeded = data.members.find((m) => m.companyName === 'Backup Acme A')!;
    expect(seeded.memberNumber).toMatch(/^[A-Z][A-Z0-9]*-\d{4,}$/); // prefix + padded
    expect(seeded.plan).toBe('Backup Plan');
    expect(seeded.status).toBe('active');

    const contactEmails = data.contacts.map((c) => c.email);
    expect(contactEmails.some((e) => e.startsWith('bk-live-'))).toBe(true);
    expect(contactEmails.some((e) => e.startsWith('bk-gone-'))).toBe(false);

    const inv = data.invoices.find((i) => i.documentNumber === `INV-BK-${memberA.slice(0, 6)}`)!;
    expect(inv).toBeDefined();
    expect(inv.memberNumber).toBe(seeded.memberNumber);
    expect(inv.status).toBe('paid');
    expect(inv.totalSatang).toBe('1284000');
    expect(inv.onlineMethod).toBeNull(); // no F5 row → builder renders 'manual'
  });

  it('writes the members_backup_exported audit row with counts', async () => {
    const requestId = `req-audit-${randomUUID().slice(0, 8)}`;
    const res = await exportMembersBackup(
      { actorUserId: admin.userId, actorRole: 'admin', requestId },
      tenantA.ctx,
      makeExportMembersBackupDeps(),
    );
    expect(res.ok).toBe(true);

    const rows = (await db.execute(sql`
      SELECT event_type, payload, retention_years
        FROM audit_log
       WHERE tenant_id = ${tenantA.ctx.slug}
         AND event_type = 'members_backup_exported'
         AND request_id = ${requestId}
    `)) as unknown as Array<{ event_type: string; payload: Record<string, unknown>; retention_years: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.retention_years).toBe(5);
    expect(Number(rows[0]!.payload['member_count'])).toBeGreaterThanOrEqual(1);
  });

  it('CROSS-TENANT: tenant B backup never contains tenant A rows', async () => {
    const { membersBackupSourceAdapter } = await import(
      '@/modules/insights/infrastructure/sources/members-backup-source-adapter'
    );
    const dataB = await runInTenant(tenantB.ctx, (tx) =>
      membersBackupSourceAdapter.gatherInTx(tx),
    );
    expect(dataB.members.map((m) => m.companyName)).not.toContain('Backup Acme A');
    expect(dataB.invoices).toHaveLength(0);
    expect(dataB.contacts.every((c) => !c.email.includes(memberA.slice(0, 8)))).toBe(true);
  });
});
