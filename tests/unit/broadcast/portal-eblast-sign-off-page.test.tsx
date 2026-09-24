/**
 * F119 T086 (FR-008, FR-009, FR-010, FR-015, FR-015a) — the member's sign-off
 * compare view on `/portal/broadcasts/[id]`.
 *
 *   1. Layout order: the latest version SENT to the member comes FIRST in the
 *      document and the member's original after it, in one `lg:grid-cols-2`
 *      grid — so a phone stacks formatted-then-original on the same page, and
 *      a wide screen puts them side by side. DOM order is the mechanism, so it
 *      is what is asserted.
 *   2. Which controls exist is the SERVER's decision, per stage:
 *        - Approve / Request changes — only while it is the member's turn
 *          (`whoseTurn === 'member'`) and a sent version exists to decide on;
 *        - Withdraw approval — only on `member_approved` / `approved` with an
 *          approval in force (round ≥ 1, `approvedVersionId` set);
 *        - Withdraw E-Blast — the Domain `canCancel` cut-off.
 *      The island is mocked to a marker that echoes what it was asked for.
 *   3. The version every decision names is the latest SENT one — the one the
 *      route compares against for `stale_version`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children?: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue(Object.assign((key: string) => key, { has: () => true })),
  getLocale: vi.fn().mockResolvedValue('en'),
}));
vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }),
}));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromRequest: () => ({ slug: 'tenant-a' }) }));
vi.mock('@/lib/env', () => ({ env: { tenant: { timezone: 'Asia/Bangkok' } } }));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/broadcast-approval-deps', () => ({ makeGetMemberVersionThreadDeps: () => ({}) }));
vi.mock('@/lib/broadcast-detail-body', () => ({
  renderBroadcastDetailBody: vi.fn(async (a: { subject: string }) => ({ status: 'ready', html: `doc:${a.subject}` })),
}));
vi.mock('@/components/broadcast/use-preview-html', () => ({
  PreviewSurface: ({ state }: { state: { html?: string } }) => <div data-testid="preview-surface">{state.html}</div>,
}));
vi.mock('@/components/broadcast/approval/version-thread', () => ({
  VersionThread: () => <div data-testid="version-thread" />,
  memberThreadModel: () => ({ original: null, rounds: [], approvedAsSubmitted: null }),
  hasThreadHistory: () => true,
}));
// UX review M5 — the Back link asks the SAME membership-access read the
// benefits page gates on (request-cached, audit-free, fail-open to `full`).
const loadMembershipAccessMock = vi.fn();
vi.mock('@/lib/load-membership-access', () => ({
  loadMembershipAccess: (...args: unknown[]) => loadMembershipAccessMock(...args),
}));
vi.mock('@/components/shell/refresh-page-button', () => ({
  RefreshPageButton: ({ label }: { label: string }) => <button data-testid="refresh-page-button">{label}</button>,
}));
vi.mock('@/components/broadcast/cancel-broadcast-action', () => ({
  CancelBroadcastAction: () => <div data-testid="cancel-action" />,
}));
vi.mock('@/components/broadcast/approval/member-sign-off-actions', () => ({
  MemberSignOffActions: (p: {
    version: { id: string } | null;
    canDecide: boolean;
    canWithdrawApproval: boolean;
    canWithdrawEblast: boolean;
  }) => (
    <div
      data-testid="sign-off-actions"
      data-version={p.version?.id ?? ''}
      data-decide={String(p.canDecide)}
      data-withdraw-approval={String(p.canWithdrawApproval)}
      data-withdraw-eblast={String(p.canWithdrawEblast)}
    />
  ),
}));

const findByLinkedUserId = vi.fn();
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ memberRepo: { findByLinkedUserId } }),
}));

const getMemberBroadcastMock = vi.fn();
const getThreadMock = vi.fn();
vi.mock('@/modules/broadcasts', async () => ({
  canCancel: (
    await vi.importActual<typeof import('@/modules/broadcasts/domain/policies/cancel-cutoff-policy')>(
      '@/modules/broadcasts/domain/policies/cancel-cutoff-policy',
    )
  ).canCancel,
  getMemberBroadcast: (...args: unknown[]) => getMemberBroadcastMock(...args),
  makeGetMemberBroadcastDeps: () => ({}),
  parseBroadcastId: (id: string) => ({ ok: true as const, value: id }),
  getMemberVersionThread: (...args: unknown[]) => getThreadMock(...args),
}));

const ID = '11111111-1111-4111-8111-111111111111';
const V0 = {
  id: 'v0-id',
  versionNo: 0,
  authoredBy: 'member',
  subject: 'Original subject',
  bodyHtml: '<p>original</p>',
  noteToMember: null,
  sentToMemberAt: null,
  createdAt: new Date('2026-09-01T03:00:00Z'),
};
const sentVersion = (n: number) => ({
  ...V0,
  id: `v${n}-id`,
  versionNo: n,
  authoredBy: 'organisation',
  subject: `Formatted subject ${n}`,
  bodyHtml: `<p>formatted ${n}</p>`,
  noteToMember: `Note for version ${n}`,
  sentToMemberAt: new Date(`2026-09-0${n + 1}T03:00:00Z`),
});

const TURN: Record<string, 'member' | 'marketing' | null> = {
  submitted: 'marketing',
  in_design: 'marketing',
  awaiting_member_approval: 'member',
  changes_requested: 'marketing',
  member_approved: 'marketing',
  approved: null,
  cancelled: null,
  sent: null,
};

interface Case {
  readonly status: string;
  readonly round: number;
  readonly approvedVersionId?: string | null;
}

function setUp({ status, round, approvedVersionId = null }: Case): void {
  getMemberBroadcastMock.mockResolvedValue({
    ok: true,
    value: {
      broadcast: {
        broadcastId: ID,
        subject: 'Original subject',
        bodyHtml: '<p>original</p>',
        status,
        estimatedRecipientCount: 42,
        submittedAt: new Date('2026-09-01T03:00:00Z'),
        sentAt: status === 'sent' ? new Date('2026-10-01T03:00:00Z') : null,
      },
      delivery: { delivered: 0, bounced: 0, softBounced: 0, complained: 0, sent: 0, total: 0 },
    },
  });
  const versions = round >= 1 ? [V0, ...Array.from({ length: round }, (_, i) => sentVersion(i + 1))] : [];
  getThreadMock.mockResolvedValue({
    ok: true,
    value: {
      broadcastId: ID,
      summary: {
        stage: status,
        whoseTurn: TURN[status] ?? null,
        round,
        proposedSendAt: new Date('2026-10-01T03:00:00Z'),
        confirmedSendAt: null,
        approvedVersionId,
        stageEnteredAt: new Date('2026-09-20T03:00:00Z'),
        expiresAt: status === 'awaiting_member_approval' ? new Date('2026-10-20T03:00:00Z') : null,
      },
      versions,
      decisions: [],
      approvedAsSubmitted: null,
    },
  });
}

async function renderPage(c: Case): Promise<string> {
  setUp(c);
  const Page = (await import('@/app/(member)/portal/broadcasts/[id]/page')).default;
  return renderToStaticMarkup((await Page({ params: Promise.resolve({ id: ID }) })) as ReactElement);
}

const attr = (html: string, name: string): string | null => {
  const m = new RegExp(`data-testid="sign-off-actions"[^>]*${name}="([^"]*)"`).exec(html);
  return m?.[1] ?? null;
};

describe('F119 T086 — the member sign-off compare view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByLinkedUserId.mockResolvedValue({ ok: true, value: { memberId: 'member-1' } });
    loadMembershipAccessMock.mockResolvedValue({ access: 'full', reason: 'in_good_standing' });
  });

  it('the formatted version comes first and the original below it, in one two-column grid', async () => {
    const html = await renderPage({ status: 'awaiting_member_approval', round: 2 });
    const formatted = html.indexOf('data-testid="eblast-formatted-version"');
    const original = html.indexOf('data-testid="eblast-member-original"');
    expect(formatted).toBeGreaterThan(-1);
    expect(original).toBeGreaterThan(formatted);
    // The LATEST sent version is the one shown — v2, not v1 — with its note.
    expect(html).toContain('doc:Formatted subject 2');
    expect(html).not.toContain('doc:Formatted subject 1');
    expect(html).toContain('Note for version 2');
    // Both halves sit in the same grid: stacked on a phone, side by side ≥ lg.
    const grid = html.slice(html.lastIndexOf('<div', formatted), formatted);
    expect(grid).toContain('lg:grid-cols-2');
  });

  it('with no version sent yet, the page shows the record body alone (no compare view)', async () => {
    const html = await renderPage({ status: 'submitted', round: 0 });
    expect(html).not.toContain('data-testid="eblast-formatted-version"');
    expect(html).toContain('doc:Original subject');
  });

  it("awaiting the member → Approve and Request changes on the latest sent version, and nothing else of the member's approval", async () => {
    const html = await renderPage({ status: 'awaiting_member_approval', round: 2 });
    expect(attr(html, 'data-decide')).toBe('true');
    expect(attr(html, 'data-version')).toBe('v2-id');
    expect(attr(html, 'data-withdraw-approval')).toBe('false');
    expect(attr(html, 'data-withdraw-eblast')).toBe('true');
  });

  it.each([
    ['member_approved', 1, 'v1-id'],
    ['approved', 1, 'v1-id'],
  ] as const)('%s with an approval in force → Withdraw approval, never Approve', async (status, round, approved) => {
    const html = await renderPage({ status, round, approvedVersionId: approved });
    expect(attr(html, 'data-decide')).toBe('false');
    expect(attr(html, 'data-withdraw-approval')).toBe('true');
  });

  it.each([
    ['approved as submitted (round 0)', { status: 'approved', round: 0 }],
    ['changes_requested', { status: 'changes_requested', round: 1 }],
    ['in_design', { status: 'in_design', round: 1 }],
  ] as const)('%s → neither Approve nor Withdraw approval', async (_label, c) => {
    const html = await renderPage(c);
    expect(attr(html, 'data-decide')).toBe('false');
    expect(attr(html, 'data-withdraw-approval')).toBe('false');
  });

  it('a closed E-Blast offers no control at all', async () => {
    const html = await renderPage({ status: 'cancelled', round: 1 });
    expect(html).not.toContain('data-testid="sign-off-actions"');
  });

  it('the stage banner is the page\'s one live region, and names the expiry while awaiting', async () => {
    const html = await renderPage({ status: 'awaiting_member_approval', round: 1 });
    const banner = html.indexOf('data-testid="eblast-stage-banner"');
    expect(banner).toBeGreaterThan(-1);
    expect(html.slice(html.lastIndexOf('<div', banner), banner)).toContain('role="status"');
    expect(html.match(/role="status"|aria-live=/g)).toHaveLength(1);
    expect(html).toContain('banner.expires');
  });

  it('a thread that cannot be read hides the decision controls and says so', async () => {
    setUp({ status: 'awaiting_member_approval', round: 1 });
    getThreadMock.mockResolvedValue({ ok: false, error: { kind: 'server_error', errKind: 'TypeError' } });
    const Page = (await import('@/app/(member)/portal/broadcasts/[id]/page')).default;
    const html = renderToStaticMarkup((await Page({ params: Promise.resolve({ id: ID }) })) as ReactElement);
    expect(html).toContain('data-testid="eblast-thread-unavailable"');
    expect(attr(html, 'data-decide')).not.toBe('true');
  });
});

const backLink = (html: string): { href: string; text: string } | null => {
  const m = /<a href="([^"]*)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/a>/.exec(html);
  return m === null ? null : { href: m[1] ?? '', text: m[2] ?? '' };
};

describe('F119 UX review — the member sign-off page around the decision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByLinkedUserId.mockResolvedValue({ ok: true, value: { memberId: 'member-1' } });
    loadMembershipAccessMock.mockResolvedValue({ access: 'full', reason: 'in_good_standing' });
  });

  it.each([
    ['full', '/portal/benefits?tab=broadcasts', 'back'],
    ['suspended', '/portal/benefits?tab=broadcasts', 'back'],
    ['terminated', '/portal', 'backToDashboard'],
  ] as const)(
    'M5 — a %s member: Back leads where the portal lets them go (%s)',
    async (access, href, label) => {
      loadMembershipAccessMock.mockResolvedValue({ access, reason: 'x' });
      const html = await renderPage({ status: 'awaiting_member_approval', round: 1 });
      expect(backLink(html)).toEqual({ href, text: label });
      expect(loadMembershipAccessMock).toHaveBeenCalledWith('tenant-a', 'member-1');
    },
  );

  it('L7 — before the first send there is no delivery breakdown (it would be all zeros)', async () => {
    const html = await renderPage({ status: 'awaiting_member_approval', round: 1 });
    expect(html).not.toContain('data-testid="delivery-breakdown"');
  });

  it('L7 — once sent, the delivery breakdown has its heading in the card header, like the other cards', async () => {
    const html = await renderPage({ status: 'sent', round: 1, approvedVersionId: 'v1-id' });
    const card = html.indexOf('data-testid="delivery-breakdown"');
    expect(card).toBeGreaterThan(-1);
    const heading = /<h2 id="delivery-breakdown-heading" class="([^"]*)"/.exec(html.slice(card));
    expect(heading?.[1]).toBe('font-heading text-base font-medium leading-snug');
    const header = html.slice(card, html.indexOf('id="delivery-breakdown-heading"', card));
    expect(header).toContain('data-slot="card-header"');
  });

  it('L6 — a real value is not muted; only the empty sentinel is', async () => {
    const html = await renderPage({ status: 'awaiting_member_approval', round: 1 });
    const at = html.indexOf('data-testid="eblast-proposed-send-at"');
    const dd = html.slice(html.lastIndexOf('<dd', at), at);
    expect(dd).not.toContain('text-muted-foreground');
  });

  it('L12 — the thread-unavailable alert offers a Refresh button', async () => {
    setUp({ status: 'awaiting_member_approval', round: 1 });
    getThreadMock.mockResolvedValue({ ok: false, error: { kind: 'server_error', errKind: 'TypeError' } });
    const Page = (await import('@/app/(member)/portal/broadcasts/[id]/page')).default;
    const html = renderToStaticMarkup((await Page({ params: Promise.resolve({ id: ID }) })) as ReactElement);
    const alert = html.indexOf('data-testid="eblast-thread-unavailable"');
    expect(html.indexOf('data-testid="refresh-page-button"', alert)).toBeGreaterThan(alert);
  });
});
