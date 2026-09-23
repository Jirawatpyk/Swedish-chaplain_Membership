/**
 * F119 T159 — the port fakes in `tests/helpers/eblast-approval-fakes.ts`
 * behave like the ports they stand in for, and drive the real use cases end
 * to end without a single inline stub: the sweep over a seeded image repo +
 * fake storage, the brand round trip, the test copy through the fake mailer.
 * A fake that drifts from its port fails here (or at compile time via
 * `satisfies`) before it can make a use-case test lie.
 */
import { describe, expect, it } from 'vitest';
import { reclaimOrphanedImages } from '@/modules/broadcasts/application/use-cases/reclaim-orphaned-images';
import { setBrandSettings } from '@/modules/broadcasts/application/use-cases/set-brand-settings';
import { getBrandSettings } from '@/modules/broadcasts/application/use-cases/get-brand-settings';
import { sendTestCopy } from '@/modules/broadcasts/application/use-cases/send-test-copy';
import { uploadInlineImage } from '@/modules/broadcasts/application/use-cases/upload-inline-image';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import {
  FAKE_TX,
  makeFakeBrandChromePort,
  makeFakeBrandSettingsRepo,
  makeFakeBroadcastImagesRepo,
  makeFakeEmailRenderer,
  makeFakeImageReencoder,
  makeFakeImageStorage,
  makeFakeTenantLogoUrlPort,
  makeFakeTestCopyMailer,
} from '../../../helpers/eblast-approval-fakes';

const TENANT = 'tenant-fakes' as never;
const NOW = new Date('2026-09-18T04:30:00Z');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

function makeAudit(): AuditPort & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    async emit(_tx, e) {
      events.push(e.eventType);
    },
    async emitTyped(_tx, e) {
      events.push(e.eventType);
    },
  };
}

describe('eblast-approval-fakes — the PR-1 ports', () => {
  it('images repo + storage: upload records a row; the sweep keeps a referenced blob and deletes an orphan', async () => {
    const imagesRepo = makeFakeBroadcastImagesRepo();
    const storage = makeFakeImageStorage();
    const audit = makeAudit();
    const allowlistPort = {
      withTx: async <T,>(_t: never, fn: (tx: unknown) => Promise<T>) => fn(null),
      findByTenantId: async () => [],
      seedDefaults: async () => undefined,
      add: async () => ({ ok: true as const, value: undefined }),
      remove: async () => ({ ok: true as const, value: undefined }),
    };
    const scanner = { scan: async () => ({ verdict: 'clean' as const, durationMs: 1 }) };
    const base = {
      tenantId: TENANT,
      actorUserId: 'u1',
      actorEmail: 'u@example.org',
      requestId: 'r',
      fileBytes: PNG,
      filename: 'a.png',
      mimeType: 'image/png',
    };
    // Two owners share one blob (a template image carried into a draft).
    const a = await uploadInlineImage({ allowlistPort, scanner, storage, audit, imagesRepo, reencoder: makeFakeImageReencoder() }, { ...base, owner: { kind: 'template', id: '11111111-1111-1111-1111-111111111111' }, actor: { role: 'admin', relatedMemberId: null } });
    const b = await uploadInlineImage({ allowlistPort, scanner, storage, audit, imagesRepo, reencoder: makeFakeImageReencoder() }, { ...base, owner: { kind: 'broadcast', id: '22222222-2222-2222-2222-222222222222' }, actor: { role: 'member', memberId: 'm-1' } });
    expect(a.ok && b.ok).toBe(true);
    expect(imagesRepo.rows).toHaveLength(2);
    expect(storage.keys.size).toBe(1);
    expect(audit.events.filter((e) => e === 'broadcast_image_uploaded')).toHaveLength(2);

    // The draft is withdrawn: its row is marked; the template's row stays live.
    await imagesRepo.markDeletedByOwner(TENANT, { kind: 'broadcast', id: '22222222-2222-2222-2222-222222222222' }, NOW, FAKE_TX);
    const sweep1 = await reclaimOrphanedImages({ imagesRepo, storage, audit }, { tenantId: TENANT, now: NOW, requestId: 'c1' });
    expect(sweep1).toEqual({ ok: true, value: { scanned: 1, blobsDeleted: 0, rowsRemoved: 1, retained: 0, rowsFailed: 0 } });
    expect(storage.deleted).toEqual([]);

    // The template goes too: now nothing references the hash — the blob is deleted.
    await imagesRepo.markDeletedByOwner(TENANT, { kind: 'template', id: '11111111-1111-1111-1111-111111111111' }, NOW, FAKE_TX);
    const sweep2 = await reclaimOrphanedImages({ imagesRepo, storage, audit }, { tenantId: TENANT, now: NOW, requestId: 'c2' });
    expect(sweep2).toEqual({ ok: true, value: { scanned: 1, blobsDeleted: 1, rowsRemoved: 1, retained: 0, rowsFailed: 0 } });
    expect(storage.deleted).toHaveLength(1);
    expect(imagesRepo.rows).toHaveLength(0);
  });

  it('brand repo + logo port: set then get round-trips through the fakes', async () => {
    const repo = makeFakeBrandSettingsRepo({ [TENANT as unknown as string]: { primaryColor: '#10487a' } });
    const audit = makeAudit();
    const set = await setBrandSettings({ repo, audit }, { tenantId: TENANT, actorUserId: 'u1', actorRole: 'admin', requestId: 'r', primaryColor: '#b04a00', postalAddress: '1 Street' });
    expect(set.ok).toBe(true);
    const view = await getBrandSettings({ repo, logoUrl: makeFakeTenantLogoUrlPort('https://blob.example/l.png') }, { tenantId: TENANT, canManageInvoiceSettings: false });
    expect(view).toMatchObject({ primaryColor: '#b04a00', postalAddress: '1 Street', addressMissing: false, logo: { url: 'https://blob.example/l.png', manageHref: null } });
    expect(audit.events).toEqual(['broadcast_brand_settings_changed']);
  });

  it('brand chrome + renderer + mailer: a test copy goes out with the fake brand and lands in `sent`', async () => {
    const mailer = makeFakeTestCopyMailer();
    const audit = makeAudit();
    const r = await sendTestCopy(
      {
        sanitizer: { sanitize: (h) => h },
        brand: makeFakeBrandChromePort({ primaryColor: '#b04a00', postalAddress: '1 Street', logoUrl: null }),
        renderer: makeFakeEmailRenderer(),
        mailer,
        audit,
      },
      { tenantId: TENANT, tenantDisplayName: 'T', actorUserId: 'u1', actorRole: 'member', actorEmail: 'me@example.org', relatedMemberId: 'm-1', broadcastId: null, versionId: null, requestId: 'r', subject: 'S', bodyHtml: '<p>b</p>', locale: 'sv' },
    );
    expect(r.ok).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: 'me@example.org', subject: '[Test] S' });
    expect(mailer.sent[0]!.html).toContain('<footer>1 Street|#b04a00</footer>');
    expect(audit.events).toEqual(['broadcast_test_copy_sent']);

    const failing = makeFakeTestCopyMailer({ failWith: 'upstream-unavailable' });
    const r2 = await sendTestCopy(
      { sanitizer: { sanitize: (h) => h }, brand: makeFakeBrandChromePort(), renderer: makeFakeEmailRenderer(), mailer: failing, audit },
      { tenantId: TENANT, tenantDisplayName: 'T', actorUserId: 'u1', actorRole: 'member', actorEmail: 'me@example.org', relatedMemberId: 'm-1', broadcastId: null, versionId: null, requestId: 'r', subject: 'S', bodyHtml: '<p>b</p>', locale: 'en' },
    );
    expect(r2).toMatchObject({ ok: false, error: { kind: 'mailer_unavailable' } });
    expect(failing.sent).toHaveLength(0);
  });
});
