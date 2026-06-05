/**
 * F9 US5 (T071/T080/T081) — export worker end-to-end integration (live Neon).
 *
 * Validates the worker ORCHESTRATION + DB state machine + artefact build + audit
 * against real Neon, with an in-memory `PrivateBlobPort` stub. The real private
 * Vercel Blob adapter (T069) is a ship-day operator gate — the linked dev store
 * is `public`, and Vercel rejects private puts until the store is provisioned
 * with private access (the adapter's SDK call is otherwise correct, verified
 * out-of-band). So the artefact bytes are captured by the stub and asserted
 * here; the private-store wiring is exercised in production.
 *
 * Covers: enqueue → process → ready + audit + SC-007 (only opt-in member in the
 * JSON), lost-claim re-process, PDF path, and generate RBAC (member forbidden).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import {
  exportDirectoryJson,
  generateDirectoryEbook,
  processExportJob,
  updateDirectoryListing,
  makeGenerateDirectoryExportDeps,
  makeUpdateDirectoryListingDeps,
} from '@/modules/insights';
import { makeProcessExportJobDeps } from '@/modules/insights/infrastructure/process-export-job-deps';
import { makeDrizzleExportJobRepo } from '@/modules/insights/infrastructure/repos/drizzle-export-job-repo';
import type {
  PrivateBlobObject,
  PrivateBlobPort,
} from '@/modules/insights/application/ports/private-blob-port';
import { exportJobs, directoryListings } from '@/modules/insights/infrastructure/db/schema-insights';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

/** In-memory PrivateBlobPort — records uploads + serves them back as a stream. */
function makeStubBlob(): PrivateBlobPort & { store: Map<string, { body: Uint8Array; contentType: string }> } {
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

describe('F9 export worker — integration (T071)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `f9-exp-${randomUUID().slice(0, 8)}`;
  const listedMember = randomUUID();
  const hiddenMember = randomUUID();
  const stubBlob = makeStubBlob();

  const workerDeps = () => ({
    ...makeProcessExportJobDeps(tenant.ctx.slug),
    blob: stubBlob,
  });

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
      for (const [id, name] of [
        [listedMember, 'Acme Exports'],
        [hiddenMember, 'Hidden Co'],
      ] as const) {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: id,
          memberNumber: nextSeedMemberNumber(),
          companyName: name,
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
          memberId: id,
          firstName: 'Contact',
          lastName: 'Person',
          email: `c-${id.slice(0, 8)}@example.com`,
          isPrimary: true,
        });
      }
    });
    await updateDirectoryListing(
      {
        memberId: listedMember,
        listed: true,
        fieldVisibility: { name: true, tier: true, industry: true },
        industry: 'Manufacturing',
        description: 'Quality widgets.',
        website: 'https://acme.example',
        locationCity: 'Bangkok',
        locationCountry: 'TH',
      },
      { actorUserId: admin.userId, actorRole: 'admin', actorMemberId: null, requestId: `exp-seed-${randomUUID()}` },
      tenant.ctx,
      makeUpdateDirectoryListingDeps(tenant.ctx.slug),
    );
  }, 180_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(exportJobs).where(eq(exportJobs.tenantId, slug)).catch(() => {});
    await db.delete(directoryListings).where(eq(directoryListings.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  const staffMeta = (requestId: string) =>
    ({ actorUserId: admin.userId, actorRole: 'admin' as const, requestId });

  it('JSON export: enqueue → process → ready; artefact has only the opt-in member (SC-007)', async () => {
    const ref = await exportDirectoryJson(
      staffMeta(`exp-json-${randomUUID()}`),
      tenant.ctx,
      makeGenerateDirectoryExportDeps(tenant.ctx.slug),
    );
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    const jobId = ref.value.jobId;
    expect(ref.value.status).toBe('requested');

    const processed = await processExportJob(jobId, tenant.ctx, workerDeps());
    expect(processed.ok).toBe(true);

    const job = await makeDrizzleExportJobRepo(tenant.ctx.slug).findById(tenant.ctx, jobId);
    expect(job?.status).toBe('ready');
    expect(job?.blobKey).toContain(jobId);

    const obj = await stubBlob.download(job!.blobKey!);
    const text = await new Response(obj!.stream).text();
    const parsed = JSON.parse(text);
    expect(parsed.count).toBe(1); // only the opted-in member (SC-007)
    expect(parsed.listings[0].name).toBe('Acme Exports');
    expect(JSON.stringify(parsed)).not.toContain('Hidden Co'); // opted-out absent

    // Production audit event emitted at ready time.
    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug));
    expect(audit.some((a) => a.eventType === 'directory_json_exported')).toBe(true);
  }, 120_000);

  it('lost-claim: re-processing an already-ready job returns lost_claim', async () => {
    const ref = await exportDirectoryJson(
      staffMeta(`exp-lc-${randomUUID()}`),
      tenant.ctx,
      makeGenerateDirectoryExportDeps(tenant.ctx.slug),
    );
    if (!ref.ok) throw new Error('enqueue failed');
    const jobId = ref.value.jobId;
    expect((await processExportJob(jobId, tenant.ctx, workerDeps())).ok).toBe(true);
    const second = await processExportJob(jobId, tenant.ctx, workerDeps());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe('lost_claim');
  }, 120_000);

  it('PDF export: enqueue → process → ready with a PDF artefact', async () => {
    const ref = await generateDirectoryEbook(
      staffMeta(`exp-pdf-${randomUUID()}`),
      tenant.ctx,
      makeGenerateDirectoryExportDeps(tenant.ctx.slug),
    );
    if (!ref.ok) throw new Error('enqueue failed');
    const jobId = ref.value.jobId;
    expect((await processExportJob(jobId, tenant.ctx, workerDeps())).ok).toBe(true);
    const job = await makeDrizzleExportJobRepo(tenant.ctx.slug).findById(tenant.ctx, jobId);
    expect(job?.status).toBe('ready');
    expect(job?.blobKey).toContain('.pdf');
    const obj = await stubBlob.download(job!.blobKey!);
    expect(obj?.contentType).toContain('pdf');
    expect(stubBlob.store.get(job!.blobKey!)!.body.length).toBeGreaterThan(1000);
  }, 120_000);

  it('member is forbidden from generating directory exports', async () => {
    const ref = await exportDirectoryJson(
      { actorUserId: admin.userId, actorRole: 'member', requestId: `exp-forbid-${randomUUID()}` },
      tenant.ctx,
      makeGenerateDirectoryExportDeps(tenant.ctx.slug),
    );
    expect(ref.ok).toBe(false);
    if (!ref.ok) expect(ref.error).toBe('forbidden');
  });
});
