/**
 * F119 T159 (PR-1) · T159a (PR-2 extends) — in-memory doubles for EVERY
 * method of EVERY port the E-Blast approval feature introduces.
 *
 * Named for its PR-2 shape (research: "T159 … named for T159a, which extends
 * it with the approval ports"); PR-1 stubs the ports IT introduces:
 *   - `BroadcastImagesRepo`   (T033)   in-memory rows, last-reference count
 *   - `BrandSettingsRepo`     (T023)   one record per tenant
 *   - `TenantLogoUrlPort`     (T027)   a fixed URL or null
 *   - `TestCopyMailerPort`    (T105)   records every send
 *   - `ImageStoragePort`      widened with `delete` (T034) — records deletes
 *   - `BrandChromePort`, `EmailRendererPort` (T031/T032) — the render seam
 * PR-2 adds `BroadcastVersionsRepo`, `BroadcastDecisionsRepo`,
 * `MarketingDirectoryPort`, `BroadcastApprovalScrubPort` (T055/T066/T082),
 * each shipped with its port's RED.
 *
 * Every fake `satisfies` its port, so a method added to a port without a
 * fake here fails to COMPILE — an unstubbed port method is an unexercised
 * branch, and a stale stub after an arity change fails silently (the F7.1a
 * `portMethodStaleTestStub` lesson). Every method is a `vi.fn` so a test can
 * override one arm without re-stubbing the port.
 */
import { vi } from 'vitest';
import { err, ok } from '@/lib/result';
import type { BrandSettings } from '@/modules/broadcasts/domain/brand/brand-settings';
import type { BrandChromePort } from '@/modules/broadcasts/application/ports/brand-chrome-port';
import type {
  BrandSettingsRecord,
  BrandSettingsRepo,
  BrandSettingsWrite,
} from '@/modules/broadcasts/application/ports/brand-settings-repo';
import type {
  BroadcastImageRecord,
  BroadcastImagesRepo,
  NewBroadcastImage,
} from '@/modules/broadcasts/application/ports/broadcast-images-repo';
import type { EmailRendererPort, RenderEmailInput } from '@/modules/broadcasts/application/ports/email-renderer-port';
import type { ImageMimeType, ImageStoragePort, StoredImageRef } from '@/modules/broadcasts/application/ports/image-storage-port';
import type { ImageReencoderPort } from '@/modules/broadcasts/application/ports/image-reencoder-port';
import type { TenantLogoUrlPort } from '@/modules/broadcasts/application/ports/tenant-logo-url-port';
import type { TestCopyMailerPort, TestCopyMessage } from '@/modules/broadcasts/application/ports/test-copy-mailer-port';

/** The sentinel tx the fakes hand to `withTx` callbacks — assert on it to prove a write shared the tx. */
export const FAKE_TX = 'fake-tx' as const;

const NO_BRAND: BrandSettings = { primaryColor: null, postalAddress: null, logoUrl: null };

// --- BroadcastImagesRepo -----------------------------------------------------

export interface FakeBroadcastImagesRepo extends BroadcastImagesRepo {
  /** Live view of every row, in insertion order. */
  readonly rows: BroadcastImageRecord[];
}

let imageSeq = 0;

export function makeFakeBroadcastImagesRepo(seed: readonly BroadcastImageRecord[] = []): FakeBroadcastImagesRepo {
  const rows: BroadcastImageRecord[] = [...seed];
  const repo = {
    rows,
    withTx: vi.fn(async <T,>(_t: never, fn: (tx: unknown) => Promise<T>) => fn(FAKE_TX)),
    record: vi.fn(async (tenantId: never, input: NewBroadcastImage, _tx: unknown): Promise<BroadcastImageRecord> => {
      imageSeq += 1;
      const row: BroadcastImageRecord = {
        id: `img-${imageSeq}`,
        tenantId: tenantId as unknown as string,
        ...input,
        createdAt: new Date('2026-09-18T00:00:00Z'),
        deletedAt: null,
      };
      rows.push(row);
      return row;
    }),
    listByOwner: vi.fn(async (tenantId: never, owner: { kind: 'broadcast' | 'template'; id: string }) =>
      rows.filter(
        (r) => r.tenantId === (tenantId as unknown as string) && r.ownerKind === owner.kind && r.ownerId === owner.id && r.deletedAt === null,
      ),
    ),
    markDeletedByOwner: vi.fn(async (tenantId: never, owner: { kind: 'broadcast' | 'template'; id: string }, at: Date) => {
      const stamped: BroadcastImageRecord[] = [];
      rows.forEach((r, i) => {
        if (r.tenantId === (tenantId as unknown as string) && r.ownerKind === owner.kind && r.ownerId === owner.id && r.deletedAt === null) {
          const next = { ...r, deletedAt: at };
          rows[i] = next;
          stamped.push(next);
        }
      });
      return stamped;
    }),
    // ROUND-2 R-M1 — the bounded prune batch's single stamp statement.
    markDeletedByOwners: vi.fn(
      async (tenantId: never, ownerKind: 'broadcast' | 'template', ownerIds: readonly string[], at: Date, _tx: unknown) => {
        const stamped: BroadcastImageRecord[] = [];
        if (ownerIds.length === 0) return stamped;
        rows.forEach((r, i) => {
          if (
            r.tenantId === (tenantId as unknown as string) &&
            r.ownerKind === ownerKind &&
            ownerIds.includes(r.ownerId) &&
            r.deletedAt === null
          ) {
            const next = { ...r, deletedAt: at };
            rows[i] = next;
            stamped.push(next);
          }
        });
        return stamped;
      },
    ),
    listMarked: vi.fn(async (tenantId: never, limit: number) =>
      rows.filter((r) => r.tenantId === (tenantId as unknown as string) && r.deletedAt !== null).slice(0, limit),
    ),
    // F2-1 — the defence-in-depth arm. The fake has no owner tables, so it
    // reports nothing by default; a test that wants an orphan overrides it.
    // F2-2 — the erasure cascade's by-member stamp. The fake holds no
    // broadcasts, so a test that needs it overrides the return.
    markDeletedForMember: vi.fn(async (_tenantId: never, _memberId: string, _at: Date, _tx: unknown) => [] as BroadcastImageRecord[]),
    listOrphaned: vi.fn(async (_tenantId: never, _limit: number) => [] as BroadcastImageRecord[]),
    countLiveByContentHash: vi.fn(async (tenantId: never, contentHash: string, _tx: unknown, excludeImageId?: string) =>
      rows.filter(
        (r) =>
          r.tenantId === (tenantId as unknown as string) &&
          r.contentHash === contentHash &&
          r.deletedAt === null &&
          r.id !== excludeImageId,
      ).length,
    ),
    // F2-10(a) — a no-op here; the real lock is SQL. Spying on it is how the
    // sweep test proves the lock is taken BEFORE the count.
    lockContentHash: vi.fn(async (_tenantId: never, _contentHash: string, _tx: unknown) => undefined),
    // F2-10(b) — the fake holds no content, so "nothing references it" is the
    // default; a test that wants the referenced branch overrides it.
    isBlobReferencedByContent: vi.fn(async (_tenantId: never, _blobUrl: string, _tx: unknown) => false),
    // ROUND-2 S-3 — the sweep's `sweep_referenced` arm un-stamps instead of
    // removing, so the row stays reachable by the erasure + orphan arms.
    restoreLive: vi.fn(async (tenantId: never, imageId: string, _tx: unknown) => {
      const i = rows.findIndex((r) => r.tenantId === (tenantId as unknown as string) && r.id === imageId);
      if (i >= 0) rows[i] = { ...rows[i]!, deletedAt: null };
    }),
    remove: vi.fn(async (tenantId: never, imageId: string) => {
      const i = rows.findIndex((r) => r.tenantId === (tenantId as unknown as string) && r.id === imageId);
      if (i >= 0) rows.splice(i, 1);
    }),
  } satisfies BroadcastImagesRepo & { rows: BroadcastImageRecord[] };
  return repo;
}

// --- BrandSettingsRepo -------------------------------------------------------

export interface FakeBrandSettingsRepo extends BrandSettingsRepo {
  readonly records: Map<string, BrandSettingsRecord>;
}

export function makeFakeBrandSettingsRepo(seed: Record<string, Partial<BrandSettingsRecord>> = {}): FakeBrandSettingsRepo {
  const records = new Map<string, BrandSettingsRecord>();
  for (const [tenant, partial] of Object.entries(seed)) {
    records.set(tenant, { primaryColor: null, postalAddress: null, updatedAt: null, updatedByUserId: null, ...partial });
  }
  const empty: BrandSettingsRecord = { primaryColor: null, postalAddress: null, updatedAt: null, updatedByUserId: null };
  return {
    records,
    withTx: vi.fn(async <T,>(_t: never, fn: (tx: unknown) => Promise<T>) => fn(FAKE_TX)),
    find: vi.fn(async (tenantId: never) => records.get(tenantId as unknown as string) ?? empty),
    save: vi.fn(async (tenantId: never, input: BrandSettingsWrite, _tx: unknown) => {
      const next: BrandSettingsRecord = {
        primaryColor: input.primaryColor,
        postalAddress: input.postalAddress,
        updatedAt: new Date('2026-09-18T00:00:00Z'),
        updatedByUserId: input.updatedByUserId,
      };
      records.set(tenantId as unknown as string, next);
      return next;
    }),
  } satisfies BrandSettingsRepo & { records: Map<string, BrandSettingsRecord> };
}

// --- TenantLogoUrlPort -------------------------------------------------------

export function makeFakeTenantLogoUrlPort(url: string | null = null): TenantLogoUrlPort {
  return { resolve: vi.fn(async () => url) } satisfies TenantLogoUrlPort;
}

// --- BrandChromePort ---------------------------------------------------------

export function makeFakeBrandChromePort(brand: BrandSettings = NO_BRAND): BrandChromePort {
  return { load: vi.fn(async () => brand) } satisfies BrandChromePort;
}

// --- EmailRendererPort -------------------------------------------------------

/** A deterministic stand-in for the wrapper: every input field is visible in the output. */
export function makeFakeEmailRenderer(): EmailRendererPort {
  return {
    render: vi.fn(
      (i: RenderEmailInput) =>
        `<!doctype html><html lang="${i.locale}"><title>${i.subject}</title>` +
        `<header>${i.brand.logoUrl ?? i.tenantDisplayName}</header>${i.bodyHtml}` +
        `<footer>${i.brand.postalAddress ?? ''}|${i.brand.primaryColor ?? ''}</footer></html>`,
    ),
  } satisfies EmailRendererPort;
}

// --- TestCopyMailerPort ------------------------------------------------------

export interface FakeTestCopyMailer extends TestCopyMailerPort {
  readonly sent: TestCopyMessage[];
}

export function makeFakeTestCopyMailer(opts: { readonly failWith?: 'upstream-unavailable' | 'invalid-recipient' } = {}): FakeTestCopyMailer {
  const sent: TestCopyMessage[] = [];
  return {
    sent,
    send: vi.fn(async (message: TestCopyMessage) => {
      if (opts.failWith) return err({ code: opts.failWith, message: 'fake' });
      sent.push(message);
      return ok({ messageId: `msg-${sent.length}` });
    }),
  } satisfies TestCopyMailerPort & { sent: TestCopyMessage[] };
}

// --- ImageStoragePort (widened with delete) ---------------------------------

export interface FakeImageStorage extends ImageStoragePort {
  /** Keys currently stored. */
  readonly keys: Set<string>;
  readonly deleted: string[];
}

function keyFor(tenantId: string, contentHash: string, mime: ImageMimeType): string {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
  return `broadcasts/images/${tenantId}/${contentHash}.${ext}`;
}

export function makeFakeImageStorage(host = 'assets.swecham.zyncdata.app'): FakeImageStorage {
  const keys = new Set<string>();
  const deleted: string[] = [];
  const refFor = (key: string): StoredImageRef => ({ blobUrl: `https://${host}/${key}`, blobKey: key });
  return {
    keys,
    deleted,
    existsByContentHash: vi.fn(async (tenantId: never, contentHash: string, mime: ImageMimeType) => {
      const key = keyFor(tenantId as unknown as string, contentHash, mime);
      return keys.has(key) ? refFor(key) : null;
    }),
    put: vi.fn(async (input: Parameters<ImageStoragePort['put']>[0]) => {
      const key = keyFor(input.tenantId as unknown as string, input.contentHash, input.mimeType);
      keys.add(key);
      return { ...refFor(key), contentHash: input.contentHash };
    }),
    delete: vi.fn(async (blobKey: string) => {
      keys.delete(blobKey);
      deleted.push(blobKey);
    }),
  } satisfies ImageStoragePort & { keys: Set<string>; deleted: string[] };
}

/**
 * F119 review finding F2-3 — pass-through `ImageReencoderPort`.
 *
 * The real strip is proven against libvips in
 * `tests/unit/broadcasts/infrastructure/sharp-image-reencoder.test.ts`. What
 * the suites using THIS fake need is a port that behaves (returns bytes, in
 * order) without pulling `sharp` — and, because it records its calls, one that
 * can still prove the use case routed the bytes THROUGH it before storing them.
 */
export interface FakeImageReencoder extends ImageReencoderPort {
  readonly calls: Array<{ readonly bytes: Uint8Array; readonly mime: ImageMimeType }>;
}

export function makeFakeImageReencoder(
  opts: { readonly failWith?: string; readonly output?: Uint8Array } = {},
): FakeImageReencoder {
  const calls: Array<{ bytes: Uint8Array; mime: ImageMimeType }> = [];
  return {
    calls,
    reencode: vi.fn(async (bytes: Uint8Array, mime: ImageMimeType) => {
      calls.push({ bytes, mime });
      if (opts.failWith !== undefined) {
        return { ok: false as const, error: { kind: 'decode_failed' as const, reason: opts.failWith } };
      }
      return { ok: true as const, value: { bytes: opts.output ?? bytes, mime } };
    }),
  };
}
