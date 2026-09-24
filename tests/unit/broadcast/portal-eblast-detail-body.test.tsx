/**
 * F119 T134 (US6-AS2, FR-049) — the member's E-Blast detail page shows the
 * E-Blast's subject AND its content.
 *
 * Before T141 the page rendered the subject, the status, the recipient count
 * and the delivery breakdown — and no body at all, so a member could not read
 * back what they had asked the chamber to send.
 *
 * Two rules are pinned here:
 *
 *  1. The body is rendered the way the PREVIEW renders it: the real email
 *     document produced by `renderBroadcastPreview` (brand header, design
 *     blocks, footer), handed to the shared `PreviewSurface` — never a raw
 *     `dangerouslySetInnerHTML` of the stored body. The stub below echoes the
 *     `PreviewSurface` state, so the assertion is on WHAT the page passes it.
 *  2. The subject is a real `<h2>` carrying the card-title font classes — the
 *     portal card convention (`portal/account/page.tsx` HubCard,
 *     `portal/profile/page.tsx` SectionHeading), NEVER the shadcn `CardTitle`
 *     `<div>`, which would drop the subject out of the SR heading tree.
 *
 * PR-1 scope (plan Amendment 5): the body is the broadcast RECORD's own
 * content. "the latest sent version while awaiting the member" needs
 * `broadcast_versions` (migration 0308) and is asserted by T141a in PR-2.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';

vi.mock('next/link', () => ({
  default: ({ children }: { children?: ReactNode }) => children as ReactElement,
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue(
    Object.assign((key: string) => key, { has: () => true }),
  ),
  getLocale: vi.fn().mockResolvedValue('en'),
}));
vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
}));
vi.mock('@/lib/env', () => ({
  env: { tenant: { timezone: 'Asia/Bangkok' } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/components/broadcast/cancel-broadcast-action', () => ({
  CancelBroadcastAction: () => null,
}));
// F119 T086 — the sign-off islands and the thread are pinned by
// `portal-eblast-sign-off-page.test.tsx`; here they are inert.
vi.mock('@/components/broadcast/approval/member-sign-off-actions', () => ({
  MemberSignOffActions: () => null,
}));
vi.mock('@/components/broadcast/approval/version-thread', () => ({
  VersionThread: () => null,
  memberThreadModel: () => ({ original: null, rounds: [], approvedAsSubmitted: null }),
  hasThreadHistory: () => false,
}));
vi.mock('@/lib/broadcast-approval-deps', () => ({ makeGetMemberVersionThreadDeps: () => ({}) }));
// UX review M5 — the Back link's access read (pinned by the sign-off page test).
vi.mock('@/lib/load-membership-access', () => ({
  loadMembershipAccess: async () => ({ access: 'full', reason: 'in_good_standing' }),
}));

const findByLinkedUserId = vi.fn();
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ memberRepo: { findByLinkedUserId } }),
}));

const getMemberBroadcastMock = vi.fn();
const renderBroadcastPreviewMock = vi.fn();
// F119 T051 — the page gates Cancel on the Domain `canCancel`; the real
// policy, not a copy of its rule.
vi.mock('@/modules/broadcasts', async () => ({
  canCancel: (
    await vi.importActual<typeof import('@/modules/broadcasts/domain/policies/cancel-cutoff-policy')>(
      '@/modules/broadcasts/domain/policies/cancel-cutoff-policy',
    )
  ).canCancel,
  getMemberBroadcast: (...args: unknown[]) => getMemberBroadcastMock(...args),
  // F119 T086 — a `sent` E-Blast approved as submitted: no version rows, so
  // the page shows the record's own content (no compare view).
  getMemberVersionThread: async () => ({
    ok: true as const,
    value: {
      summary: {
        stage: 'sent',
        whoseTurn: null,
        round: 0,
        proposedSendAt: null,
        confirmedSendAt: null,
        approvedVersionId: null,
        stageEnteredAt: new Date('2026-09-02T03:00:00.000Z'),
        expiresAt: null,
      },
      versions: [],
      decisions: [],
      approvedAsSubmitted: null,
    },
  }),
  makeGetMemberBroadcastDeps: () => ({}),
  parseBroadcastId: (id: string) => ({ ok: true as const, value: id }),
  renderBroadcastPreview: (...args: unknown[]) =>
    renderBroadcastPreviewMock(...args),
}));
vi.mock('@/lib/broadcast-brand-deps', () => ({
  makeRenderBroadcastPreviewDeps: vi
    .fn()
    .mockResolvedValue({ tenantDisplayName: 'Tenant A' }),
}));

/**
 * Echo the state the page hands the shared surface — the assertion is on the
 * page's choice of document, not on the iframe chrome (which `PreviewSurface`
 * itself owns and `preview-pane-empty-state.test.tsx` already covers).
 */
vi.mock('@/components/broadcast/use-preview-html', () => ({
  PreviewSurface: ({ state }: { state: { status: string; html?: string } }) => (
    <div data-testid="preview-surface" data-status={state.status}>
      {state.html ?? ''}
    </div>
  ),
}));

const BODY_HTML = '<p>The autumn mixer is on 12 October.</p>';
const SUBJECT = 'Autumn mixer — save the date';

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    value: {
      broadcast: {
        broadcastId: '11111111-1111-4111-8111-111111111111',
        subject: SUBJECT,
        bodyHtml: BODY_HTML,
        status: 'sent',
        estimatedRecipientCount: 42,
        submittedAt: new Date('2026-09-01T03:00:00.000Z'),
        sentAt: new Date('2026-09-02T03:00:00.000Z'),
        ...overrides,
      },
      delivery: {
        delivered: 40,
        bounced: 1,
        softBounced: 0,
        complained: 0,
        sent: 41,
        total: 42,
      },
    },
  };
}

async function renderPage(): Promise<string> {
  const mod = await import('@/app/(member)/portal/broadcasts/[id]/page');
  const Page = mod.default;
  return renderToStaticMarkup(
    await Page({
      params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
    }),
  );
}

describe('F119 T134 — portal E-Blast detail body (US6-AS2, FR-049)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByLinkedUserId.mockResolvedValue({
      ok: true,
      value: { memberId: 'member-1' },
    });
    getMemberBroadcastMock.mockResolvedValue(makeResult());
    renderBroadcastPreviewMock.mockResolvedValue({
      ok: true,
      value: { html: `<!doctype html><html><body>${BODY_HTML}</body></html>` },
    });
  });

  it('the detail renders the subject and the body from the broadcast record\'s own content', async () => {
    const html = await renderPage();

    expect(html).toContain(SUBJECT);
    // The body reached the shared preview surface as a READY document…
    expect(html).toContain('data-status="ready"');
    // …and that document was rendered from the record's own subject + body.
    expect(renderBroadcastPreviewMock).toHaveBeenCalledTimes(1);
    const [, input] = renderBroadcastPreviewMock.mock.calls[0] as [
      unknown,
      { subject: string; bodyHtml: string; surface: string },
    ];
    expect(input.subject).toBe(SUBJECT);
    expect(input.bodyHtml).toBe(BODY_HTML);
    // ROUND-3 #11 — a read-back is a DETAIL render, not the member's compose
    // preview; the two share the renderer but not the traffic shape.
    expect(input.surface).toBe('detail');
    // Never injected into the page's own DOM.
    expect(html).not.toContain('dangerouslySetInnerHTML');
  });

  it('renders the subject as a real <h2> with the card-title font classes, not a CardTitle div', async () => {
    const html = await renderPage();

    const heading = /<h2[^>]*id="broadcast-detail-fields-heading"[^>]*>/.exec(
      html,
    );
    expect(heading).not.toBeNull();
    expect(heading?.[0]).toContain('font-heading');
    expect(heading?.[0]).not.toContain('text-h4');
  });

  it('a failed render degrades to the shared error state instead of throwing', async () => {
    renderBroadcastPreviewMock.mockRejectedValue(new Error('brand read down'));

    const html = await renderPage();

    expect(html).toContain('data-status="error"');
    expect(html).toContain(SUBJECT);
  });
});
