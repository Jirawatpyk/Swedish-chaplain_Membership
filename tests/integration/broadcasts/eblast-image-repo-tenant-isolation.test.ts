/**
 * ROUND-2 T-2 — Constitution Principle I clause 3: every tenant-scoped table
 * gets a cross-tenant integration test, and `broadcast_images` (migration
 * 0304) had none.
 *
 * The three reads that could leak are the ones that take an identifier from
 * OUTSIDE the row: `markDeletedForMember` joins to `broadcasts` by member,
 * `listOrphaned` anti-joins two owner tables, and `isBlobReferencedByContent`
 * searches two content columns for a URL. Each is written with an explicit
 * `tenant_id` predicate AND runs under RLS+FORCE; this suite is what proves
 * both halves actually hold against the deployed schema rather than in the
 * docblock.
 *
 * ROUND-2 S-4 rides along here too: `isBlobReferencedByContent` used
 * leading-wildcard `LIKE` with the URL interpolated unescaped, so a blob key
 * containing `_` matched ANY character in that position and the sweep could
 * answer "still referenced" about a different image. The `position()` arm is
 * pinned with a URL that differs from the stored one only in that character.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { drizzleBroadcastImagesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcast-images-repo';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const HOST = 'assets.swecham.zyncdata.app';

async function seedDraft(
  tenant: TestTenant,
  broadcastId: string,
  memberId: string,
  bodyHtml: string,
): Promise<void> {
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
        ${'member_self_service'}, ${'Isolation subject'}, ${bodyHtml}, ${'plain'},
        ${'Test Member via Test Chamber'}, ${'reply@example.com'},
        ${'all_members'}, NULL, NULL, ${0}, ${'draft'}::broadcast_status,
        ${5}, now(), now()
      )
    `),
  );
}

async function seedImage(
  tenant: TestTenant,
  ownerId: string,
  contentHash: string,
  blobKey: string,
): Promise<string> {
  return runInTenant(tenant.ctx, async (tx) => {
    const row = await drizzleBroadcastImagesRepo.record(
      tenant.ctx.slug as never,
      {
        ownerKind: 'broadcast',
        ownerId,
        contentHash,
        blobUrl: `https://${HOST}/${blobKey}`,
        blobKey,
        mimeType: 'image/png',
        byteSize: 1024,
        uploadedByUserId: randomUUID(),
      },
      tx,
    );
    return row.id;
  });
}

describe('broadcast_images — cross-tenant isolation (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  const memberA = randomUUID();
  const memberB = randomUUID();
  const draftA = randomUUID();
  const draftB = randomUUID();
  const orphanDraftB = randomUUID();

  const hashA = `a${randomUUID().replace(/-/g, '')}`;
  const hashB = `b${randomUUID().replace(/-/g, '')}`;
  const keyB = `broadcasts/images/tenant-b/${hashB}.png`;
  const urlB = `https://${HOST}/${keyB}`;

  beforeAll(async () => {
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-swecham');

    await seedDraft(tenantA, draftA, memberA, '<p>A owns this</p>');
    await seedDraft(tenantB, draftB, memberB, `<p><img src="${urlB}"></p>`);
    // B's orphan: an image row whose owner broadcast is then hard-deleted, so
    // it is exactly what B's own `listOrphaned` would return.
    await seedDraft(tenantB, orphanDraftB, memberB, '<p>about to vanish</p>');

    await seedImage(tenantA, draftA, hashA, `broadcasts/images/tenant-a/${hashA}.png`);
    await seedImage(tenantB, orphanDraftB, hashB, keyB);

    await runInTenant(tenantB.ctx, (tx) =>
      tx.execute(sql`
        DELETE FROM broadcasts
         WHERE tenant_id = ${tenantB.ctx.slug} AND broadcast_id = ${orphanDraftB}::uuid
      `),
    );
  }, 180_000);

  afterAll(async () => {
    // `createTestTenant`'s cleanup does not know about `broadcast_images`, so
    // remove this suite's rows explicitly before the tenants go.
    await db
      .execute(
        sql`DELETE FROM broadcast_images WHERE tenant_id IN (${tenantA.ctx.slug}, ${tenantB.ctx.slug})`,
      )
      .catch(() => undefined);
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 180_000);

  it(
    "markDeletedForMember in tenant A stamps NOTHING for a member of tenant B — and B's row stays live",
    async () => {
      const stamped = await runInTenant(tenantA.ctx, (tx) =>
        drizzleBroadcastImagesRepo.markDeletedForMember(
          tenantA.ctx.slug as never,
          memberB,
          new Date(),
          tx,
        ),
      );
      expect(stamped).toEqual([]);

      // Read back with the RLS-bypassing owner connection: a count of 0 inside
      // A's context would pass for the wrong reason (RLS hiding the row) even
      // if the UPDATE had stamped it.
      const rows = (await db.execute(sql`
        SELECT tenant_id, (deleted_at IS NOT NULL) AS marked
          FROM broadcast_images
         WHERE content_hash IN (${hashA}, ${hashB})
      `)) as unknown as Array<{ tenant_id: string; marked: boolean }>;
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.marked === false)).toBe(true);
    },
    180_000,
  );

  it(
    "listOrphaned in tenant A never returns tenant B's orphan, though B's own sweep sees it",
    async () => {
      const seenByA = await runInTenant(tenantA.ctx, (tx) =>
        drizzleBroadcastImagesRepo.listOrphaned(tenantA.ctx.slug as never, 200, tx),
      );
      expect(seenByA.map((r) => r.contentHash)).not.toContain(hashB);
      expect(seenByA.every((r) => r.tenantId === (tenantA.ctx.slug as unknown as string))).toBe(true);

      // The positive control: without it, an empty result would "pass" even if
      // the anti-join were broken and returned nothing for anyone.
      const seenByB = await runInTenant(tenantB.ctx, (tx) =>
        drizzleBroadcastImagesRepo.listOrphaned(tenantB.ctx.slug as never, 200, tx),
      );
      expect(seenByB.map((r) => r.contentHash)).toContain(hashB);
    },
    180_000,
  );

  it(
    "isBlobReferencedByContent in tenant A is false for a URL only tenant B's content embeds",
    async () => {
      const inA = await runInTenant(tenantA.ctx, (tx) =>
        drizzleBroadcastImagesRepo.isBlobReferencedByContent(tenantA.ctx.slug as never, urlB, tx),
      );
      expect(inA).toBe(false);

      // Positive control in B, so a blanket `false` cannot pass this suite.
      const inB = await runInTenant(tenantB.ctx, (tx) =>
        drizzleBroadcastImagesRepo.isBlobReferencedByContent(tenantB.ctx.slug as never, urlB, tx),
      );
      expect(inB).toBe(true);
    },
    180_000,
  );

  it(
    'S-4: a URL differing only by an underscore does NOT match — the search is substring, not LIKE',
    async () => {
      // `urlB` is stored in B's `body_html`. Replace ONE character of the hash
      // with `_`: under `LIKE '%' || url || '%'` that is a single-character
      // wildcard and matches the stored URL, so the sweep would keep bytes it
      // should have reclaimed. Under `position()` it is a literal underscore.
      const index = urlB.length - 6;
      const withUnderscore = `${urlB.slice(0, index)}_${urlB.slice(index + 1)}`;
      expect(withUnderscore).not.toBe(urlB);
      expect(withUnderscore).toHaveLength(urlB.length);

      const matched = await runInTenant(tenantB.ctx, (tx) =>
        drizzleBroadcastImagesRepo.isBlobReferencedByContent(
          tenantB.ctx.slug as never,
          withUnderscore,
          tx,
        ),
      );
      expect(matched).toBe(false);
    },
    180_000,
  );
});
