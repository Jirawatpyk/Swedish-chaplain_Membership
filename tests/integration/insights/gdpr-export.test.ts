/**
 * F9 US6 (T086) — GDPR archive end-to-end integration (live Neon).
 *
 * Validates the request → worker → archive flow against real Neon with an
 * in-memory `PrivateBlobPort` stub: the produced ZIP contains every category +
 * README + manifest; the manifest SHA-256 checksums validate (SC-008); and the
 * audit subset is scoped (member-performed ∪ member-targeted) + redacted
 * (third-party email payload fields + summary emails stripped; an unrelated
 * member's audit row is absent).
 *
 * F119 R17 — `broadcast-images.json` carries every image uploaded for the
 * member's own E-Blasts, live AND stamped (the stamped row is the record); a
 * stamped image has no `blobUrl`, and the uploader is never named.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
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
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { drizzleBroadcastImagesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcast-images-repo';

const IMAGE_HOST = 'assets.swecham.zyncdata.app';

/** One draft E-Blast originated by `memberId` (same raw shape as the image isolation suite). */
async function seedDraftBroadcast(tenant: TestTenant, broadcastId: string, memberId: string): Promise<void> {
  await runInTenant(tenant.ctx, (tx) =>
    tx.execute(sql`
      INSERT INTO broadcasts (
        tenant_id, broadcast_id, requested_by_member_id,
        requested_by_member_plan_id_snapshot, submitted_by_user_id,
        actor_role, subject, body_html, body_source, from_name,
        reply_to_email, segment_type, segment_params,
        custom_recipient_emails, estimated_recipient_count, status,
        retention_years, created_at, updated_at
      ) VALUES (
        ${tenant.ctx.slug}, ${broadcastId}::uuid, ${memberId}::uuid,
        ${'plan-test'}, ${randomUUID()}::uuid,
        ${'member_self_service'}, ${'GDPR image subject'}, ${'<p>body</p>'}, ${'plain'},
        ${'Test Member via Test Chamber'}, ${'reply@example.com'},
        ${'all_members'}, NULL, NULL, ${0}, ${'draft'}::broadcast_status,
        ${5}, now(), now()
      )
    `),
  );
}

/** One `broadcast_images` row on `ownerId`; returns its id. */
async function seedBroadcastImage(
  tenant: TestTenant,
  ownerId: string,
  contentHash: string,
  uploadedByUserId: string,
): Promise<string> {
  const blobKey = `broadcasts/images/${tenant.ctx.slug}/${contentHash}.png`;
  return runInTenant(tenant.ctx, async (tx) => {
    const row = await drizzleBroadcastImagesRepo.record(
      tenant.ctx.slug as never,
      {
        ownerKind: 'broadcast',
        ownerId,
        contentHash,
        blobUrl: `https://${IMAGE_HOST}/${blobKey}`,
        blobKey,
        mimeType: 'image/png',
        byteSize: 2048,
        uploadedByUserId,
      },
      tx,
    );
    return row.id;
  });
}

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
  // F119 R17 — the subject's own E-Blast carries one live + one stamped image;
  // a peer member's E-Blast in the SAME tenant carries one image that must not appear.
  const subjectBroadcast = randomUUID();
  const peerBroadcast = randomUUID();
  const liveHash = `live${randomUUID().replace(/-/g, '')}`;
  const stampedHash = `stamped${randomUUID().replace(/-/g, '')}`;
  const peerHash = `peer${randomUUID().replace(/-/g, '')}`;
  const uploaderIds = [randomUUID(), randomUUID(), randomUUID()] as const;
  let liveImageId = '';
  let stampedImageId = '';

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
        memberNumber: nextSeedMemberNumber(),
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

    await seedDraftBroadcast(tenant, subjectBroadcast, subject);
    await seedDraftBroadcast(tenant, peerBroadcast, otherMember);
    // The stamped row comes from the path that really produces one the export
    // can see — the erasure cascade's `markDeletedForMember`, which stamps and
    // KEEPS the (redacted) E-Blast. Discard and prune hard-delete the E-Blast
    // first, so their images never reach this join. The live image is seeded
    // AFTER the stamp (the stamp reaches every live image of the member); an
    // upload after an erasure is not a real sequence — this models the read
    // shape, one live + one stamped row, not a lifecycle.
    stampedImageId = await seedBroadcastImage(tenant, subjectBroadcast, stampedHash, uploaderIds[1]);
    await seedBroadcastImage(tenant, peerBroadcast, peerHash, uploaderIds[2]);
    const stamped = await runInTenant(tenant.ctx, (tx) =>
      drizzleBroadcastImagesRepo.markDeletedForMember(
        tenant.ctx.slug as never,
        subject,
        new Date(),
        tx,
      ),
    );
    // Only the subject's row — the peer's image is untouched.
    expect(stamped.map((r) => r.id)).toEqual([stampedImageId]);
    liveImageId = await seedBroadcastImage(tenant, subjectBroadcast, liveHash, uploaderIds[0]);
  }, 180_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    // `createTestTenant`'s cleanup does not know about `broadcast_images`.
    await db.execute(sql`DELETE FROM broadcast_images WHERE tenant_id = ${slug}`).catch(() => {});
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
        'broadcast-images.json', // F119 R17 — every archive carries it
        'broadcast-versions.json', // F119 T083 — every archive carries it (empty when the member has no approval round)
        'broadcasts.json',
        'change-requests.json', // F114 T079 — every archive carries it (empty when the member has no requests)
        'contacts.json',
        'events.json',
        'invoices.json',
        'manifest.json',
        'profile.json',
      ].sort(),
    );
    // F114: the change-request category is present, an array, and empty for a member who never proposed a change
    expect(JSON.parse(strFromU8(files['change-requests.json']!))).toEqual([]);

    // Member's own data present.
    const profile = JSON.parse(strFromU8(files['profile.json']!));
    expect(profile.companyName).toBe('Acme Exports Co');
    // Staff on-behalf export (no linked requester) — every contact is a
    // colleague to the archive's reader: name + role only (Art. 15(4)).
    const contactsJson = JSON.parse(strFromU8(files['contacts.json']!));
    expect(contactsJson[0]).toEqual({ firstName: 'Som', lastName: 'Chai', roleTitle: null, isPrimary: true });
    expect(strFromU8(files['contacts.json']!)).not.toContain('som.chai@acme.example');

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

  it("F119 R17: broadcast-images.json holds the member's own images, live AND stamped — a stamped one without its URL, no uploader named, no peer's image", async () => {
    const ref = await requestDataExport(
      { subjectMemberId: subject },
      {
        actorUserId: admin.userId,
        actorRole: 'admin',
        actorMemberId: null,
        requesterLocale: 'en',
        requestId: `gdpr-img-${randomUUID()}`,
      },
      tenant.ctx,
      makeRequestDataExportDeps(tenant.ctx.slug),
    );
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    // Same-minute re-request dedupes onto the job the test above already built
    // (from the same seed) — process only a freshly created one.
    if (ref.value.created) {
      expect((await processExportJob(ref.value.jobId, tenant.ctx, workerDeps())).ok).toBe(true);
    }
    const job = await makeDrizzleExportJobRepo(tenant.ctx.slug).findById(tenant.ctx, ref.value.jobId);
    const files = unzipSync(stubBlob.store.get(job!.blobKey!)!.body);

    const raw = strFromU8(files['broadcast-images.json']!);
    const images = JSON.parse(raw) as Array<Record<string, unknown>>;
    expect(images.map((i) => i.imageId).sort()).toEqual([liveImageId, stampedImageId].sort());

    const live = images.find((i) => i.imageId === liveImageId)!;
    expect(live).toMatchObject({
      broadcastId: subjectBroadcast,
      contentHash: liveHash,
      mimeType: 'image/png',
      byteSize: 2048,
      deletedAt: null,
      blobUrl: `https://${IMAGE_HOST}/broadcasts/images/${tenant.ctx.slug}/${liveHash}.png`,
    });
    const stamped = images.find((i) => i.imageId === stampedImageId)!;
    expect(stamped.contentHash).toBe(stampedHash);
    expect(typeof stamped.deletedAt).toBe('string');
    expect(stamped).not.toHaveProperty('blobUrl');

    // The archive never names a user — no uploader key, no uploader id.
    for (const image of images) expect(image).not.toHaveProperty('uploadedByUserId');
    for (const uploader of uploaderIds) expect(raw).not.toContain(uploader);
    expect(raw).not.toContain(peerHash);
  }, 180_000);

  it("GDPR Art. 15(4) / PDPA §30: a colleague's archive holds no other contact's email and no other colleague's own account activity", async () => {
    const requester = await createActiveTestUser('member');
    const colleague = await createActiveTestUser('member');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(contacts).values([
        {
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId: subject,
          firstName: 'Req',
          lastName: 'Uester',
          email: `req-${randomUUID()}@acme.example`,
          isPrimary: false,
          linkedUserId: requester.userId,
        },
        {
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId: subject,
          firstName: 'Anna',
          lastName: 'Lindqvist',
          email: 'anna.lindqvist@acme.example',
          isPrimary: false,
          linkedUserId: colleague.userId,
        },
      ]);
      // The colleague's own sign-in — their personal data, not the requester's.
      await tx.insert(auditLog).values({
        tenantId: tenant.ctx.slug,
        eventType: 'sign_in_success',
        actorUserId: colleague.userId,
        targetUserId: colleague.userId,
        summary: 'colleague-login-marker',
        requestId: randomUUID(),
        payload: null,
      });
    });

    const ref = await requestDataExport(
      { subjectMemberId: subject },
      {
        actorUserId: requester.userId,
        actorRole: 'member',
        actorMemberId: subject,
        requesterLocale: 'en',
        requestId: `gdpr-colleague-${randomUUID()}`,
      },
      tenant.ctx,
      makeRequestDataExportDeps(tenant.ctx.slug),
    );
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    expect((await processExportJob(ref.value.jobId, tenant.ctx, workerDeps())).ok).toBe(true);
    const job = await makeDrizzleExportJobRepo(tenant.ctx.slug).findById(tenant.ctx, ref.value.jobId);
    const files = unzipSync(stubBlob.store.get(job!.blobKey!)!.body);

    const contactsRaw = strFromU8(files['contacts.json']!);
    expect(contactsRaw).not.toContain('anna.lindqvist@acme.example');
    expect(contactsRaw).not.toContain('som.chai@acme.example');
    const roster = JSON.parse(contactsRaw) as Array<Record<string, unknown>>;
    expect(roster.find((c) => c.firstName === 'Anna')).toEqual({ firstName: 'Anna', lastName: 'Lindqvist', roleTitle: null, isPrimary: false });
    expect(roster.find((c) => c.firstName === 'Req')).toHaveProperty('email');

    const auditRaw = strFromU8(files['audit-events.json']!);
    expect(auditRaw).not.toContain('colleague-login-marker');
  }, 180_000);
});
