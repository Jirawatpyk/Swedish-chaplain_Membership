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
 * each shipped with its port's RED — plus `ActorNameDirectoryPort` (T061,
 * staff display names for the version thread), which T159a's list omits,
 * and the two T059 / T060 ports: `MemberPortalRecipientPort` (active portal
 * contacts) and `EblastNotificationOutboxPort` (whose rows live in the
 * approval store, so a rollback discards them — SC-004).
 *
 * Every fake `satisfies` its port, so a method added to a port without a
 * fake here fails to COMPILE — an unstubbed port method is an unexercised
 * branch, and a stale stub after an arity change fails silently (the F7.1a
 * `portMethodStaleTestStub` lesson). Every method is a `vi.fn` so a test can
 * override one arm without re-stubbing the port.
 */
import { vi, type Mocked } from 'vitest';
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
import { asBroadcastId, type Broadcast, type BroadcastId } from '@/modules/broadcasts/domain/broadcast';
import type { BroadcastVersion } from '@/modules/broadcasts/domain/approval/broadcast-version';
import type { MemberDecision } from '@/modules/broadcasts/domain/approval/member-decision';
import type { BroadcastStatus } from '@/modules/broadcasts/domain/value-objects/broadcast-status';
import type { ActorNameDirectoryPort } from '@/modules/broadcasts/application/ports/actor-name-directory-port';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type { BroadcastDecisionsRepo, NewMemberDecision } from '@/modules/broadcasts/application/ports/broadcast-decisions-repo';
import type {
  BroadcastVersionsRepo,
  NewBroadcastVersion,
  WorkingCopyWrite,
} from '@/modules/broadcasts/application/ports/broadcast-versions-repo';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { Hostname, ImageAllowlistPort } from '@/modules/broadcasts/application/ports/image-allowlist-port';
import type { ApprovalBroadcastsRepo } from '@/modules/broadcasts/application/use-cases/approval/_approval-tx';
import type {
  EblastNotificationEnqueue,
  EblastNotificationOutboxPort,
} from '@/modules/broadcasts/application/ports/eblast-notification-outbox-port';
import type { MemberPortalRecipientPort, PortalContact } from '@/modules/broadcasts/application/ports/member-portal-recipient-port';
import type { MarketingDirectoryPort, MarketingRecipient } from '@/modules/broadcasts/application/ports/marketing-directory-port';
import type { BroadcastApprovalScrubPort } from '@/modules/broadcasts/application/ports/broadcast-approval-scrub-port';
import type { TenantContext, TenantSlug } from '@/modules/tenants';

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
    // F119 R17 — the GDPR export's by-member read; same no-broadcasts default.
    listByMember: vi.fn(async (_tenantId: never, _memberId: string, _limit: number, _tx: unknown) => [] as BroadcastImageRecord[]),
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
    // ROUND-3 #4 — a no-op here; the real bound is `SET LOCAL`. Spying on it
    // is how the sweep test proves the tx is bounded before it blocks on
    // anything.
    setStatementTimeout: vi.fn(async (_ms: number, _tx: unknown) => undefined),
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
    findForUpdate: vi.fn(async (tenantId: never, _tx: unknown) => records.get(tenantId as unknown as string) ?? empty),
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
  /**
   * ROUND-3 #1 — force the Nth (1-based) `existsByContentHash` call to answer
   * something other than the truth, so a test can model what the real adapter
   * does: `'absent'` is a genuine 404, `'unknown'` is a `head` that FAILED
   * (rate-limit / token / outage) and therefore knows nothing. The upload asks
   * twice — once as the dedup short-circuit and once again under the
   * content-hash lock — and the two answers must be steerable independently.
   */
  readonly probeOverrides: Map<number, 'absent' | 'unknown'>;
}

function keyFor(tenantId: string, contentHash: string, mime: ImageMimeType): string {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
  return `broadcasts/images/${tenantId}/${contentHash}.${ext}`;
}

export function makeFakeImageStorage(
  opts: {
    readonly host?: string;
    /**
     * ROUND-3 #1 — model `allowOverwrite: false`. `@vercel/blob` THROWS when
     * the pathname already holds an object, so a PUT of bytes that are already
     * there is not the silent no-op the adapter's comment used to claim.
     *
     * The thrown message below is VERBATIM from the live dev store
     * (measured 2026-09-22 with a deliberate duplicate PUT) — a plain
     * `BlobError`, since the SDK has no already-exists subclass. Keep it
     * byte-identical: it is what `isBlobAlreadyExists` is pinned against.
     */
    readonly rejectDuplicatePut?: boolean;
  } = {},
): FakeImageStorage {
  const host = opts.host ?? 'assets.swecham.zyncdata.app';
  const keys = new Set<string>();
  const deleted: string[] = [];
  const probeOverrides = new Map<number, 'absent' | 'unknown'>();
  let probeCalls = 0;
  const refFor = (key: string): StoredImageRef => ({ blobUrl: `https://${host}/${key}`, blobKey: key });
  return {
    keys,
    deleted,
    probeOverrides,
    existsByContentHash: vi.fn(async (tenantId: never, contentHash: string, mime: ImageMimeType) => {
      probeCalls += 1;
      const override = probeOverrides.get(probeCalls);
      if (override === 'absent') return { status: 'absent' as const };
      if (override === 'unknown') {
        return { status: 'unknown' as const, reason: 'fake: head failed' };
      }
      const key = keyFor(tenantId as unknown as string, contentHash, mime);
      return keys.has(key)
        ? { status: 'present' as const, ...refFor(key) }
        : { status: 'absent' as const };
    }),
    put: vi.fn(async (input: Parameters<ImageStoragePort['put']>[0]) => {
      const key = keyFor(input.tenantId as unknown as string, input.contentHash, input.mimeType);
      if (opts.rejectDuplicatePut === true && keys.has(key)) {
        throw new Error(
          'Vercel Blob: This blob already exists, use `allowOverwrite: true` if you want to overwrite it. ' +
            'Or `addRandomSuffix: true` to generate a unique filename. ' +
            'Read more about this error in our documentation: https://vercel.link/blob-allow-overwrite',
        );
      }
      keys.add(key);
      return { ...refFor(key), contentHash: input.contentHash };
    }),
    delete: vi.fn(async (blobKey: string) => {
      keys.delete(blobKey);
      deleted.push(blobKey);
    }),
  } satisfies ImageStoragePort & {
    keys: Set<string>;
    deleted: string[];
    probeOverrides: Map<number, 'absent' | 'unknown'>;
  };
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

// =============================================================================
// F119 PR-2 — T159a, sequenced per port (round 5 A6): these land with T055's
// RED. `BroadcastVersionsRepo` + `BroadcastDecisionsRepo` (T055) and the
// `ActorNameDirectoryPort` T061 reads staff names through. `MarketingDirectoryPort`
// (T066) and `BroadcastApprovalScrubPort` (T082) join with their own tasks.
// =============================================================================

/** The wall-clock the approval fakes stamp rows with (override per store). */
export const APPROVAL_NOW = new Date('2026-09-24T09:00:00.000Z');

const APPROVAL_TENANT = 'test-tenant';

/** A complete `Broadcast` row for the approval round — `submitted`, round 0, with a proposal. */
export function makeApprovalBroadcast(overrides: Partial<Broadcast> = {}): Broadcast {
  return {
    tenantId: APPROVAL_TENANT,
    broadcastId: asBroadcastId('11111111-1111-4111-8111-111111111111'),
    requestedByMemberId: '22222222-2222-4222-8222-222222222222',
    requestedByMemberPlanIdSnapshot: 'plan-premium',
    submittedByUserId: '33333333-3333-4333-8333-333333333333',
    actorRole: 'member_self_service',
    subject: 'Member original subject',
    bodyHtml: '<p>Member original body</p>',
    bodySource: '{"type":"doc","content":[]}',
    fromName: 'Acme via SweCham',
    replyToEmail: 'owner@acme.test',
    segmentType: 'custom',
    segmentParams: null,
    customRecipientEmails: ['a@acme.test'],
    estimatedRecipientCount: 1,
    status: 'submitted',
    submittedAt: new Date('2026-09-20T08:00:00.000Z'),
    approvedAt: null,
    approvedByUserId: null,
    rejectedAt: null,
    rejectedByUserId: null,
    rejectionReason: null,
    scheduledFor: new Date('2026-10-01T03:00:00.000Z'),
    sendingStartedAt: null,
    sentAt: null,
    cancelledAt: null,
    cancelledByUserId: null,
    cancellationReason: null,
    failedToDispatchAt: null,
    failureReason: null,
    quotaYearConsumed: null,
    quotaConsumedAt: null,
    resendAudienceId: null,
    audienceImportId: null,
    audienceImportSubmittedAt: null,
    audienceImportCompletedAt: null,
    resendBroadcastId: null,
    retentionYears: 5,
    manualRetryCount: 0,
    partialDeliveryAcceptedAt: null,
    partialDeliveryAcceptedByUserId: null,
    templateProvenance: null,
    proposedSendAt: new Date('2026-10-01T03:00:00.000Z'),
    stageEnteredAt: new Date('2026-09-20T08:00:00.000Z'),
    currentRound: 0,
    approvedVersionId: null,
    memberReminderStage: 0,
    memberExpiryNotifiedAt: null,
    createdAt: new Date('2026-09-20T07:00:00.000Z'),
    updatedAt: new Date('2026-09-20T08:00:00.000Z'),
    ...overrides,
  };
}

/** A `BroadcastVersion` row (defaults: v1, a working copy of the default broadcast). */
export function makeApprovalVersion(overrides: Partial<BroadcastVersion> = {}): BroadcastVersion {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    tenantId: APPROVAL_TENANT,
    broadcastId: asBroadcastId('11111111-1111-4111-8111-111111111111'),
    versionNo: 1,
    subject: 'Formatted subject',
    bodyHtml: '<p>Formatted body</p>',
    bodySource: '{"type":"doc","content":[]}',
    noteToMember: null,
    authoredByUserId: '44444444-4444-4444-8444-444444444444',
    authoredByRole: 'admin_proxy',
    sentToMemberAt: null,
    createdAt: APPROVAL_NOW,
    updatedAt: APPROVAL_NOW,
    ...overrides,
  };
}

/** One `notifications_outbox` row the approval round enqueued, with the tx it rode on. */
export interface FakeOutboxRow extends EblastNotificationEnqueue {
  readonly tx: unknown;
  readonly tenantId: string;
}

export interface ApprovalStoreState {
  readonly broadcasts: Map<string, Broadcast>;
  versions: BroadcastVersion[];
  decisions: MemberDecision[];
  /** Outbox rows live in the store so the `withTx` rollback discards them too (SC-004). */
  outbox: FakeOutboxRow[];
}

/** Every method is a `vi.fn` (so a test can override one arm), plus the live rows. */
export type FakeApprovalBroadcastsRepo = Mocked<ApprovalBroadcastsRepo> & {
  readonly rows: Map<string, Broadcast>;
};

export type FakeBroadcastVersionsRepo = Mocked<BroadcastVersionsRepo> & {
  /** Live view of every version row, `version_no` insertion order. */
  readonly rows: () => readonly BroadcastVersion[];
};

export type FakeBroadcastDecisionsRepo = Mocked<BroadcastDecisionsRepo> & {
  readonly rows: () => readonly MemberDecision[];
};

export type FakeEblastOutbox = Mocked<EblastNotificationOutboxPort> & {
  readonly rows: () => readonly FakeOutboxRow[];
};

export interface FakeApprovalStore {
  readonly state: ApprovalStoreState;
  readonly broadcastsRepo: FakeApprovalBroadcastsRepo;
  readonly versionsRepo: FakeBroadcastVersionsRepo;
  readonly decisionsRepo: FakeBroadcastDecisionsRepo;
  readonly outbox: FakeEblastOutbox;
  /** The clock rows are stamped with; tests move it to model time passing. */
  now: Date;
  /**
   * SC-004 — make the NEXT `withTx` fail at COMMIT: the callback runs to
   * completion (every write, the outbox enqueue included), then the store is
   * rolled back and the call throws. A throw before the enqueue would prove
   * nothing about where the enqueue ran.
   */
  failNextCommit(): void;
}

const keyOf = (tenantId: string, broadcastId: string) => `${tenantId}::${broadcastId}`;
let approvalSeq = 0;
const nextApprovalId = (prefix: string) => {
  approvalSeq += 1;
  return `${prefix}-0000-4000-8000-${String(approvalSeq).padStart(12, '0')}`;
};

/**
 * One in-memory store behind the three approval-round repos, so a write
 * through one is visible to the others inside the same "transaction".
 *
 * `withTx` is a REAL rollback boundary: it snapshots the store and restores
 * it when the callback throws — the fake analogue of throw-to-rollback, so a
 * test can prove a refused call left nothing behind. It also enforces the two
 * `broadcast_versions` unique indexes (`(broadcast, version_no)` and ONE
 * unsent row per E-Blast), because a version use case that violated them
 * would pass against a fake that did not.
 *
 * Every method is a `vi.fn`; every repo `satisfies` its port, so a method
 * added to a port without a fake here fails to COMPILE.
 */
export function makeFakeApprovalStore(
  seed: {
    readonly broadcasts?: readonly Broadcast[];
    readonly versions?: readonly BroadcastVersion[];
    readonly decisions?: readonly MemberDecision[];
  } = {},
): FakeApprovalStore {
  const state: ApprovalStoreState = {
    broadcasts: new Map((seed.broadcasts ?? []).map((b) => [keyOf(b.tenantId, b.broadcastId), b])),
    versions: [...(seed.versions ?? [])],
    decisions: [...(seed.decisions ?? [])],
    outbox: [],
  };
  let failCommit = false;
  const store = {
    state,
    now: APPROVAL_NOW,
    failNextCommit: () => {
      failCommit = true;
    },
  } as FakeApprovalStore;

  const broadcastsRepo = {
    rows: state.broadcasts,
    withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const snapshot = {
        broadcasts: new Map(state.broadcasts),
        versions: [...state.versions],
        decisions: [...state.decisions],
        outbox: [...state.outbox],
      };
      try {
        const result = await fn(FAKE_TX);
        if (failCommit) {
          failCommit = false;
          throw new Error('fake commit failure');
        }
        return result;
      } catch (e) {
        state.broadcasts.clear();
        for (const [k, v] of snapshot.broadcasts) state.broadcasts.set(k, v);
        state.versions = snapshot.versions;
        state.decisions = snapshot.decisions;
        state.outbox = snapshot.outbox;
        throw e;
      }
    }),
    lockForUpdate: vi.fn(async (_tx: unknown, tenantId: TenantSlug, broadcastId: BroadcastId) =>
      state.broadcasts.get(keyOf(tenantId as string, broadcastId))?.status ?? null,
    ),
    findByIdInTx: vi.fn(async (_tx: unknown, tenantId: TenantSlug, broadcastId: BroadcastId) =>
      state.broadcasts.get(keyOf(tenantId as string, broadcastId)) ?? null,
    ),
    applyTransition: vi.fn(
      async (
        _tx: unknown,
        tenantId: TenantSlug,
        broadcastId: BroadcastId,
        target: BroadcastStatus,
        fields: Partial<Broadcast>,
        expectedFromStatus: BroadcastStatus,
      ): Promise<Broadcast> => {
        const key = keyOf(tenantId as string, broadcastId);
        const row = state.broadcasts.get(key);
        if (row === undefined || row.status !== expectedFromStatus) {
          throw new BroadcastConcurrentMutationError(tenantId, broadcastId, expectedFromStatus);
        }
        const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        // Mirrors the Drizzle adapter: a real status change stamps the stage
        // clock unless the caller passed one; a same-status write does not.
        const stamp = target !== expectedFromStatus && fields.stageEnteredAt === undefined ? { stageEnteredAt: store.now } : {};
        const next: Broadcast = { ...row, ...stamp, ...defined, status: target, updatedAt: store.now };
        state.broadcasts.set(key, next);
        return next;
      },
    ),
    // `withTx` is generic on the port and a `vi.fn` cannot carry the type
    // parameter, so it is checked by presence; every other method is checked
    // against the port's signature.
  } satisfies Omit<ApprovalBroadcastsRepo, 'withTx'> & Record<'withTx', unknown> & { rows: Map<string, Broadcast> };

  // T083 — the member's own E-Blasts, for the two DSAR reads.
  const ownedBy = (tenantId: string, memberId: string) =>
    new Set(
      [...state.broadcasts.values()]
        .filter((b) => b.tenantId === tenantId && b.requestedByMemberId === memberId)
        .map((b) => b.broadcastId as string),
    );

  const versionsRepo = {
    rows: () => state.versions,
    listSentByMember: vi.fn(async (tenantId: TenantSlug, memberId: string, limit: number, _tx: unknown) => {
      const owned = ownedBy(tenantId as string, memberId);
      return state.versions
        .filter((v) => v.tenantId === (tenantId as string) && owned.has(v.broadcastId as string) && v.sentToMemberAt !== null)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.versionNo - a.versionNo)
        .slice(0, limit);
    }),
    listByBroadcast: vi.fn(async (tenantId: TenantSlug, broadcastId: BroadcastId, _tx: unknown) =>
      state.versions
        .filter((v) => v.tenantId === (tenantId as string) && v.broadcastId === broadcastId)
        .sort((a, b) => a.versionNo - b.versionNo),
    ),
    insert: vi.fn(async (tenantId: TenantSlug, input: NewBroadcastVersion, _tx: unknown): Promise<BroadcastVersion> => {
      const siblings = state.versions.filter((v) => v.tenantId === (tenantId as string) && v.broadcastId === input.broadcastId);
      if (siblings.some((v) => v.versionNo === input.versionNo)) {
        throw new Error('duplicate key value violates unique constraint "broadcast_versions_broadcast_version_no_uniq"');
      }
      if (input.sentToMemberAt === null && siblings.some((v) => v.sentToMemberAt === null)) {
        throw new Error('duplicate key value violates unique constraint "broadcast_versions_one_unsent_idx"');
      }
      const row: BroadcastVersion = {
        id: nextApprovalId('bbbbbbbb'),
        tenantId: tenantId as string,
        ...input,
        createdAt: store.now,
        updatedAt: store.now,
      };
      state.versions = [...state.versions, row];
      return row;
    }),
    updateWorkingCopy: vi.fn(
      async (tenantId: TenantSlug, versionId: string, write: WorkingCopyWrite, _tx: unknown): Promise<BroadcastVersion | null> => {
        const i = state.versions.findIndex(
          (v) => v.tenantId === (tenantId as string) && v.id === versionId && v.sentToMemberAt === null,
        );
        if (i < 0) return null;
        const next: BroadcastVersion = { ...state.versions[i]!, ...write };
        state.versions = state.versions.map((v, j) => (j === i ? next : v));
        return next;
      },
    ),
    // T059 — the send stamp; matches only an unsent row, like the SQL.
    markSent: vi.fn(
      async (tenantId: TenantSlug, versionId: string, sentAt: Date, _tx: unknown): Promise<BroadcastVersion | null> => {
        const i = state.versions.findIndex(
          (v) => v.tenantId === (tenantId as string) && v.id === versionId && v.sentToMemberAt === null,
        );
        if (i < 0) return null;
        const next: BroadcastVersion = { ...state.versions[i]!, sentToMemberAt: sentAt, updatedAt: sentAt };
        state.versions = state.versions.map((v, j) => (j === i ? next : v));
        return next;
      },
    ),
  } satisfies BroadcastVersionsRepo & { rows: () => readonly BroadcastVersion[] };

  const decisionsRepo = {
    rows: () => state.decisions,
    listByMember: vi.fn(async (tenantId: TenantSlug, memberId: string, limit: number, _tx: unknown) => {
      const owned = ownedBy(tenantId as string, memberId);
      return state.decisions
        .filter((d) => d.tenantId === (tenantId as string) && owned.has(d.broadcastId as string))
        .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime())
        .slice(0, limit);
    }),
    insert: vi.fn(async (tenantId: TenantSlug, input: NewMemberDecision, _tx: unknown): Promise<MemberDecision> => {
      const row: MemberDecision = {
        id: nextApprovalId('cccccccc'),
        tenantId: tenantId as string,
        ...input,
        decidedAt: store.now,
      };
      state.decisions = [...state.decisions, row];
      return row;
    }),
    listByBroadcast: vi.fn(async (tenantId: TenantSlug, broadcastId: BroadcastId, _tx: unknown) =>
      state.decisions
        .filter((d) => d.tenantId === (tenantId as string) && d.broadcastId === broadcastId)
        .sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime()),
    ),
  } satisfies BroadcastDecisionsRepo & { rows: () => readonly MemberDecision[] };

  // T059 / T060 — the approval-round outbox. The row lands in the store
  // state, so a refusal thrown later in the same `withTx` rolls it back.
  const outbox = {
    rows: () => state.outbox,
    enqueueInTx: vi.fn(async (tx: unknown, tenant: TenantContext, request: EblastNotificationEnqueue): Promise<void> => {
      state.outbox = [...state.outbox, { ...request, tx, tenantId: tenant.slug as string }];
    }),
  } satisfies EblastNotificationOutboxPort & { rows: () => readonly FakeOutboxRow[] };

  return Object.assign(store, {
    broadcastsRepo: broadcastsRepo as unknown as FakeApprovalBroadcastsRepo,
    versionsRepo: versionsRepo as unknown as FakeBroadcastVersionsRepo,
    decisionsRepo: decisionsRepo as unknown as FakeBroadcastDecisionsRepo,
    outbox: outbox as unknown as FakeEblastOutbox,
  });
}

// --- MemberPortalRecipientPort (T059 / T060) ---------------------------------

/** A portal contact of the default approval broadcast's member. */
export function makePortalContact(overrides: Partial<PortalContact> = {}): PortalContact {
  return {
    contactId: 'dddddddd-0000-4000-8000-000000000001',
    email: 'owner@acme.test',
    locale: 'th',
    linkedUserId: '33333333-3333-4333-8333-333333333333',
    isPrimary: true,
    ...overrides,
  };
}

/** Active portal contacts per member id; a member absent from the map has none. */
export function makeFakePortalRecipients(
  byMember: Readonly<Record<string, readonly PortalContact[]>> = {},
): Mocked<MemberPortalRecipientPort> {
  return {
    listActivePortalContacts: vi.fn(async (_tenant: TenantContext, memberId: string, _tx: unknown) => byMember[memberId] ?? []),
  } satisfies MemberPortalRecipientPort;
}

// --- MarketingDirectoryPort (T066) -------------------------------------------

/** A marketing recipient as the roster returns one (platform-default locale). */
export function makeMarketingRecipient(overrides: Partial<MarketingRecipient> = {}): MarketingRecipient {
  return { userId: '44444444-4444-4444-8444-444444444444', email: 'marketing@swecham.test', locale: 'en', ...overrides };
}

/** The hand-off roster, fixed; an empty roster is `[]` (the real adapter counts it). */
export function makeFakeMarketingDirectory(recipients: readonly MarketingRecipient[] = [makeMarketingRecipient()]): Mocked<MarketingDirectoryPort> {
  return {
    listRecipients: vi.fn(async () => recipients),
  } satisfies MarketingDirectoryPort;
}

/** `BroadcastVersionsRepo` alone (a store with no broadcasts behind it). */
export function makeFakeBroadcastVersionsRepo(seed: readonly BroadcastVersion[] = []): FakeBroadcastVersionsRepo {
  return makeFakeApprovalStore({ versions: seed }).versionsRepo;
}

/** `BroadcastDecisionsRepo` alone — append-only by construction (no update method exists). */
export function makeFakeBroadcastDecisionsRepo(seed: readonly MemberDecision[] = []): FakeBroadcastDecisionsRepo {
  return makeFakeApprovalStore({ decisions: seed }).decisionsRepo;
}

// --- BroadcastApprovalScrubPort (T082) ---------------------------------------

export type FakeBroadcastApprovalScrub = Mocked<BroadcastApprovalScrubPort>;

const SENTINEL = '[redacted]';

/**
 * The erasure reach over an approval store: redacts the versions and the
 * decision reasons of every E-Blast the member originated and drops their
 * pending outbox rows — the SQL's rules, including "a NULL note / an
 * approval without a note stays NULL" and changed-rows counts (0 on a
 * re-drive). With no store it changes nothing and reports zeros.
 */
export function makeFakeBroadcastApprovalScrub(store?: FakeApprovalStore): FakeBroadcastApprovalScrub {
  const ownedBy = (tenantId: string, memberId: string) =>
    new Set(
      [...(store?.state.broadcasts.values() ?? [])]
        .filter((b) => b.tenantId === tenantId && b.requestedByMemberId === memberId)
        .map((b) => b.broadcastId as string),
    );
  return {
    redactVersionsForMemberInTx: vi.fn(async (_tx: unknown, tenantId: TenantSlug, memberId: string) => {
      if (store === undefined) return { redactedCount: 0 };
      const owned = ownedBy(tenantId as string, memberId);
      let redactedCount = 0;
      store.state.versions = store.state.versions.map((v) => {
        const note = v.noteToMember === null ? null : SENTINEL;
        const done = v.subject === SENTINEL && v.bodyHtml === SENTINEL && v.bodySource === SENTINEL && v.noteToMember === note;
        if (v.tenantId !== (tenantId as string) || !owned.has(v.broadcastId as string) || done) return v;
        redactedCount += 1;
        return { ...v, subject: SENTINEL, bodyHtml: SENTINEL, bodySource: SENTINEL, noteToMember: note };
      });
      return { redactedCount };
    }),
    redactDecisionReasonsForMemberInTx: vi.fn(async (_tx: unknown, tenantId: TenantSlug, memberId: string) => {
      if (store === undefined) return { redactedCount: 0 };
      const owned = ownedBy(tenantId as string, memberId);
      let redactedCount = 0;
      store.state.decisions = store.state.decisions.map((d) => {
        if (d.tenantId !== (tenantId as string) || !owned.has(d.broadcastId as string) || d.reason === null || d.reason === SENTINEL) return d;
        redactedCount += 1;
        return { ...d, reason: SENTINEL };
      });
      return { redactedCount };
    }),
    cancelPendingNotificationsForMemberInTx: vi.fn(async (_tx: unknown, tenantId: TenantSlug, memberId: string) => {
      if (store === undefined) return { cancelledCount: 0 };
      const owned = ownedBy(tenantId as string, memberId);
      const keep = store.state.outbox.filter(
        (r) => r.tenantId !== (tenantId as string) || !owned.has(String(r.contextData.broadcastId)),
      );
      const cancelledCount = store.state.outbox.length - keep.length;
      store.state.outbox = keep;
      return { cancelledCount };
    }),
  } satisfies BroadcastApprovalScrubPort;
}

// --- ActorNameDirectoryPort (T061) ------------------------------------------

export function makeFakeActorNameDirectory(names: Readonly<Record<string, string | null>> = {}): ActorNameDirectoryPort {
  return {
    resolveNames: vi.fn(async (ids: readonly string[]) => {
      const out = new Map<string, string | null>();
      for (const id of ids) if (Object.prototype.hasOwnProperty.call(names, id)) out.set(id, names[id] ?? null);
      return out;
    }),
  } satisfies ActorNameDirectoryPort;
}

// --- AuditPort (recording) ---------------------------------------------------

export interface RecordedAuditEvent {
  readonly tx: unknown;
  readonly eventType: string;
  readonly actorUserId: string;
  readonly payload: unknown;
  readonly tenantId: string | null;
}

export interface RecordingF7Audit extends AuditPort {
  readonly events: RecordedAuditEvent[];
}

/** An `AuditPort` that records every row (typed or not) with the tx it rode on. */
export function makeRecordingF7Audit(): RecordingF7Audit {
  const events: RecordedAuditEvent[] = [];
  const record = async (tx: unknown, e: { eventType: string; actorUserId: string; payload: unknown; tenantId: string | null }) => {
    events.push({ tx, eventType: e.eventType, actorUserId: e.actorUserId, payload: e.payload, tenantId: e.tenantId });
  };
  return {
    events,
    emit: vi.fn(record),
    emitTyped: vi.fn(record) as AuditPort['emitTyped'],
  };
}

// --- ImageAllowlistPort (the per-tenant image-source allow-list) ------------

export function makeFakeImageAllowlist(hosts: readonly string[] = ['assets.swecham.zyncdata.app']): ImageAllowlistPort {
  const entries = hosts.map((h) => ({ hostname: h as Hostname, isDefault: true }));
  return {
    withTx: vi.fn(async <T,>(_t: never, fn: (tx: unknown) => Promise<T>) => fn(FAKE_TX)),
    findByTenantId: vi.fn(async () => entries),
    seedDefaults: vi.fn(async () => undefined),
    add: vi.fn(async () => ok(undefined)),
    remove: vi.fn(async () => ok(undefined)),
  } satisfies ImageAllowlistPort;
}
