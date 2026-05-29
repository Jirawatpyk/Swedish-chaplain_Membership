/**
 * F9 US6 (T086) — GDPR archive end-to-end integration (live Neon).
 *
 * Validates the request → worker → archive flow against real Neon with an
 * in-memory `PrivateBlobPort` stub: the produced ZIP contains every category +
 * README + manifest; the manifest SHA-256 checksums validate (SC-008); and the
 * audit subset is scoped (member-performed ∪ member-targeted) + redacted
 * (third-party email payload fields + summary emails stripped; an unrelated
 * member's audit row is absent).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { db, runInTenant } from '@/lib/db';
import { requestDataExport, processExportJob, makeRequestDataExportDeps } from '@/modules/insights';
import { makeProcessExportJobDeps } from '@/modules/insights/infrastructure/process-export-job-deps';
import { makeDrizzleExportJobRepo } from '@/modules/insights/infrastructure/repos/drizzle-export-job-repo';
import type {
  PrivateBlobObject,
  PrivateBlobPort,
} from '@/modules/insights/application/ports/private-blob-port';
import { exportJobs } from '@/modules/insights/infrastructure/db/schema-insights';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

function makeStubBlob(): PrivateBlobPort & {
  store: Map<string, { body: Uint8Array; contentType: string }>;
} {
  const store = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    store,
    async putPrivate({ key, body, contentType }) {
      store.set(key, { body, contentType });
      return { key };
    },
    async download(key): Promise<PrivateBlobObject | null> {
      const obj = store.get(key);
      if (obj === undefined) return null;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(obj.body);
          c.close();
        },
      });
      return { stream, contentType: obj.contentType };
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

describe('F9 GDPR archive — integration (T086)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `f9-gdpr-${randomUUID().slice(0, 8)}`;
  const subject = randomUUID();
  const otherMember = randomUUID();
  const stubBlob = makeStubBlob();

  const workerDeps = () => ({ ...makeProcessExportJobDeps(tenant.ctx.slug), blob: stubBlob });

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Corporate Gold' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: subject,
        companyName: 'Acme Exports Co',
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
        riskScore: null,
        riskScoreBand: null,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId: subject,
        firstName: 'Som',
        lastName: 'Chai',
        email: 'som.chai@acme.example',
        isPrimary: true,
      });
      // Member-targeted audit row carrying a third-party email payload field +
      // an email in the summary — both must be redacted in the archive. `email`
      // is in the standard projection's GLOBAL deny-list (any event type).
      await tx.insert(auditLog).values({
        tenantId: tenant.ctx.slug,
        eventType: 'member_updated',
        actorUserId: 'system:test',
        summary: 'updated member contact old@x.com',
        requestId: randomUUID(),
        payload: { member_id: subject, email: 'old@x.com', fields_changed: ['email'] },
      });
      // Member-targeted via the `subject_member_id` payload arm (F9/on-behalf
      // taxonomy) — exercises the second JSONB union arm of the SQL reader
      // against live Neon (staff-review test gap).
      await tx.insert(auditLog).values({
        tenantId: tenant.ctx.slug,
        eventType: 'data_export_requested',
        actorUserId: 'system:test',
        summary: 'export requested on behalf',
        requestId: randomUUID(),
        payload: { job_id: randomUUID(), subject_member_id: subject, on_behalf: true },
      });
      // Unrelated member's audit row — must NOT appear in the subject's archive.
      await tx.insert(auditLog).values({
        tenantId: tenant.ctx.slug,
        eventType: 'member_created',
        actorUserId: 'system:test',
        summary: 'created other member',
        requestId: randomUUID(),
        payload: { member_id: otherMember },
      });
    });
  }, 180_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(exportJobs).where(eq(exportJobs.tenantId, slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('request → process → ready: archive has every category + README + valid manifest (SC-008)', async () => {
    const ref = await requestDataExport(
      { subjectMemberId: subject },
      {
        actorUserId: admin.userId,
        actorRole: 'admin',
        actorMemberId: null,
        requesterLocale: 'en',
        requestId: `gdpr-${randomUUID()}`,
      },
      tenant.ctx,
      makeRequestDataExportDeps(tenant.ctx.slug),
    );
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    const jobId = ref.value.jobId;

    const processed = await processExportJob(jobId, tenant.ctx, workerDeps());
    expect(processed.ok).toBe(true);

    const job = await makeDrizzleExportJobRepo(tenant.ctx.slug).findById(tenant.ctx, jobId);
    expect(job?.status).toBe('ready');
    expect(job?.blobKey).toContain('.zip');

    const obj = stubBlob.store.get(job!.blobKey!)!;
    const files = unzipSync(obj.body);
    const names = Object.keys(files).sort();
    expect(names).toEqual(
      [
        'README.txt',
        'audit-events.json',
        'broadcasts.json',
        'contacts.json',
        'events.json',
        'invoices.json',
        'manifest.json',
        'profile.json',
      ].sort(),
    );

    // Member's own data present.
    const profile = JSON.parse(strFromU8(files['profile.json']!));
    expect(profile.companyName).toBe('Acme Exports Co');
    const contactsJson = JSON.parse(strFromU8(files['contacts.json']!));
    expect(contactsJson[0].email).toBe('som.chai@acme.example');

    // Manifest checksums validate over every non-manifest entry (SC-008).
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    expect(manifest.subjectMemberId).toBe(subject);
    for (const entry of manifest.files as Array<{ path: string; sha256: string; bytes: number }>) {
      const content = files[entry.path]!;
      expect(content, `missing ${entry.path}`).toBeDefined();
      expect(createHash('sha256').update(content).digest('hex')).toBe(entry.sha256);
    }

    // Audit subset: scoped + redacted.
    const auditEvents = JSON.parse(strFromU8(files['audit-events.json']!)) as Array<{
      eventType: string;
      summary: string;
      payload: Record<string, unknown> | null;
    }>;
    const changeRow = auditEvents.find(
      (e) => (e.payload as { member_id?: string } | null)?.member_id === subject,
    );
    expect(changeRow, 'member-targeted row present').toBeDefined();
    // The `subject_member_id` payload arm of the SQL reader is exercised: the
    // on-behalf request row scoped via subject_member_id is also in the subset.
    const subjRow = auditEvents.find(
      (e) => (e.payload as { subject_member_id?: string } | null)?.subject_member_id === subject,
    );
    expect(subjRow, 'subject_member_id-scoped row present').toBeDefined();
    // Third-party email payload field stripped (standard role projection).
    expect(changeRow!.payload).not.toHaveProperty('email');
    // Structured member id retained for accountability (the member's own).
    expect(changeRow!.payload).toMatchObject({ member_id: subject });
    // Summary email redacted.
    expect(changeRow!.summary).not.toContain('old@x.com');
    // The unrelated member's audit row is absent.
    const archiveText = JSON.stringify(auditEvents);
    expect(archiveText).not.toContain(otherMember);
  }, 180_000);
});
