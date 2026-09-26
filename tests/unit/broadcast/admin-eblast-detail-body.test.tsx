/**
 * ROUND-3 #2 — the approval surface must show the document that SHIPS.
 *
 * `/admin/broadcasts/[id]` is where a chamber officer approves or rejects an
 * E-Blast, and it rendered the raw sanitised body with
 * `dangerouslySetInnerHTML`. Every other surface — the member's read-back, the
 * preview, the test copy and the dispatch itself — goes through
 * `renderBroadcastPreview` / `renderBroadcastHtml`, which apply the design
 * blocks and the tenant's brand. So the approver saw three text links where
 * the recipients get three brand-coloured buttons, and signed off on a
 * document nobody receives.
 *
 * Two things are pinned here:
 *
 *  1. the page hands the STORED body to the same server-side renderer the
 *     portal detail uses and puts the result in the shared `PreviewSurface`
 *     (sandboxed `<iframe srcdoc>`) — never into this page's own DOM;
 *  2. the difference is real: the same stored body, through the two paths,
 *     produces a `bgcolor` CTA table on the delivered side and a bare `<a>`
 *     on the old one. Collaborators for that second part are the REAL
 *     sanitiser and the REAL email renderer, so it cannot pass by agreeing
 *     with a stub.
 *
 * Mirrors `portal-eblast-detail-body.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrandHexColor } from '@/modules/broadcasts/domain/brand/brand-settings';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';
import { dompurifySanitizer } from '@/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer';
import { emailTemplateRenderer } from '@/modules/broadcasts/infrastructure/resend/email-template-renderer';
import { renderBroadcastPreview } from '@/modules/broadcasts/application/use-cases/render-broadcast-preview';
import { canCancel } from '@/modules/broadcasts/domain/policies/cancel-cutoff-policy';
import { canTransition } from '@/modules/broadcasts/domain/policies/broadcast-status-transitions';

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
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/rbac', () => ({
  requirePagePermission: vi.fn().mockResolvedValue({ user: { id: 'staff-1', role: 'admin' } }),
  canPerform: () => true,
}));
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async () => [{ company_name: 'Northern Lights Co' }]),
}));
vi.mock('@/components/broadcast/cancel-broadcast-action', () => ({
  CancelBroadcastAction: () => <div data-testid="cancel-action" />,
}));
// F119 B1 — the marker surfaces which half of the pair the page asked for.
vi.mock('@/components/broadcast/admin/review-actions', () => ({
  ReviewActions: (p: { showApprove?: boolean; showReject?: boolean }) => (
    <div data-testid="review-actions">
      {p.showApprove === true ? <span data-testid="approve-action" /> : null}
      {p.showReject === true ? <span data-testid="reject-action" /> : null}
    </div>
  ),
}));
vi.mock('@/components/broadcast/admin/audit-timeline', () => ({
  AuditTimeline: () => null,
}));
// Async server components in the tree suspend under `renderToStaticMarkup`;
// none of them is what this file measures.
vi.mock('@/components/broadcast/admin/status-badge', () => ({
  StatusBadge: () => <span data-testid="status-badge" />,
}));
vi.mock('@/components/broadcast/admin/manager-readonly-banner', () => ({
  ManagerReadonlyBanner: () => null,
}));
// F119 T063 — the page now reads the version thread and the standing
// warnings, and mounts the approval islands; none of them is what this file
// measures (`admin-eblast-detail-actions.test.tsx` owns the controls).
vi.mock('@/lib/broadcast-approval-deps', () => ({
  makeListBroadcastVersionsDeps: () => ({}),
  makeReadFormattingWarningsDeps: () => ({}),
  makeReadDispatchHoldDeps: () => ({}),
}));
vi.mock('@/components/shell/relative-time', () => ({ RelativeTime: () => null }));
vi.mock('@/components/shell/refresh-page-button', () => ({
  RefreshPageButton: ({ label }: { label: string }) => <button data-testid="refresh-page-button">{label}</button>,
}));
vi.mock('@/components/broadcast/approval/start-formatted-version-action', () => ({
  StartFormattedVersionAction: () => null,
}));
vi.mock('@/components/broadcast/approval/schedule-confirm-dialog', () => ({
  ScheduleConfirmAction: () => null,
}));
vi.mock('@/components/broadcast/approval/formatted-version-workspace', () => ({
  FormattedVersionWorkspace: () => null,
}));

const findByIdMock = vi.fn();
const renderBroadcastPreviewMock = vi.fn();
// F119 T051 — the page gates Cancel on the Domain `canCancel`; the real
// policy, not a copy of its rule.
vi.mock('@/modules/broadcasts', async () => ({
  canTransition: (
    await vi.importActual<typeof import('@/modules/broadcasts/domain/policies/broadcast-status-transitions')>(
      '@/modules/broadcasts/domain/policies/broadcast-status-transitions',
    )
  ).canTransition,
  canCancel: (
    await vi.importActual<typeof import('@/modules/broadcasts/domain/policies/cancel-cutoff-policy')>(
      '@/modules/broadcasts/domain/policies/cancel-cutoff-policy',
    )
  ).canCancel,
  makeGetBroadcastDeps: () => ({ broadcastsRepo: { findById: findByIdMock } }),
  parseBroadcastId: (id: string) => ({ ok: true as const, value: id }),
  renderBroadcastPreview: (...args: unknown[]) => renderBroadcastPreviewMock(...args),
  // F119 T063 — no version rows on these fixtures, so the page shows the
  // record's own body (the surface this file pins).
  stageOf: (status: string) => status,
  turnOf: () => null,
  isEblastMemberApprovalEnabled: () => false,
  isF71aUs2Enabled: () => false,
  listBroadcastVersions: vi.fn(async () => ({ ok: false, error: { kind: 'not_found' } })),
  readFormattingWarnings: vi.fn(async () => ({ ok: true, value: { hasPortalUser: true, unsafeImages: [] } })),
  // F119 PR-A R1 — the "held for payment" note; this file renders none.
  readDispatchHold: vi.fn(async () => ({ ok: true, value: false })),
}));
vi.mock('@/lib/broadcast-brand-deps', () => ({
  makeRenderBroadcastPreviewDeps: vi
    .fn()
    .mockResolvedValue({ tenantDisplayName: 'Tenant A' }),
}));

/** Echo the state the page hands the shared surface. */
vi.mock('@/components/broadcast/use-preview-html', () => ({
  PreviewSurface: ({ state }: { state: { status: string; html?: string } }) => (
    <div data-testid="preview-surface" data-status={state.status}>
      {state.html ?? ''}
    </div>
  ),
}));

const CTA_BODY =
  '<p>Doors open at six.</p>' +
  '<a data-eb="cta" href="https://example.org/go" target="_blank" rel="noopener noreferrer nofollow">Register</a>';
const SUBJECT = 'Autumn mixer — save the date';

function makeBroadcast(over: Record<string, unknown> = {}) {
  return {
    broadcastId: '11111111-1111-4111-8111-111111111111',
    subject: SUBJECT,
    bodyHtml: CTA_BODY,
    status: 'submitted',
    actorRole: 'member',
    segmentType: 'all_members',
    estimatedRecipientCount: 42,
    requestedByMemberId: 'member-1',
    submittedAt: new Date('2026-09-01T03:00:00.000Z'),
    scheduledFor: null,
    proposedSendAt: null,
    stageEnteredAt: new Date('2026-09-01T03:00:00.000Z'),
    currentRound: 0,
    approvedVersionId: null,
    ...over,
  };
}

async function renderPage(): Promise<string> {
  const mod = await import('@/app/(staff)/admin/broadcasts/[id]/page');
  const Page = mod.default;
  return renderToStaticMarkup(
    await Page({
      params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
    }),
  );
}

describe('ROUND-3 #2 — the staff approval surface renders the DELIVERED document', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByIdMock.mockResolvedValue(makeBroadcast());
    renderBroadcastPreviewMock.mockResolvedValue({
      ok: true,
      value: { html: `<!doctype html><html><body>${CTA_BODY}</body></html>` },
    });
  });

  it('renders the body through the shared renderer into the sandboxed surface, never dangerouslySetInnerHTML', async () => {
    const html = await renderPage();

    expect(html).toContain('data-status="ready"');
    expect(renderBroadcastPreviewMock).toHaveBeenCalledTimes(1);
    const [, input] = renderBroadcastPreviewMock.mock.calls[0] as [
      unknown,
      { subject: string; bodyHtml: string; surface: string },
    ];
    expect(input.subject).toBe(SUBJECT);
    expect(input.bodyHtml).toBe(CTA_BODY);
    // The approval surface is a DETAIL read-back, not a compose preview —
    // ROUND-3 #11 gives the two detail pages their own metric label.
    expect(input.surface).toBe('detail');
    expect(html).not.toContain('dangerouslySetInnerHTML');
  });

  /**
   * The staff surface keeps IMP-3's explicit warning panel rather than the
   * member surface's quiet error state: an approver needs to be told WHY the
   * body is missing, and Approve has to be unavailable. That is the one piece
   * of staff-only chrome around the shared document.
   */
  it('a render failure shows the alert panel and blocks Approve', async () => {
    renderBroadcastPreviewMock.mockRejectedValue(new Error('brand read down'));

    const html = await renderPage();

    expect(html).toContain('role="alert"');
    expect(html).toContain('bodyRenderFailedTitle');
    expect(html).toContain(SUBJECT);
    // The body is never shown at all on this path.
    expect(html).not.toContain('data-testid="preview-surface"');
    // Staff must not sign off on content the server could not render —
    // though they may still refuse it (Reject is not a sign-off).
    expect(html).not.toContain('data-testid="approve-action"');
    expect(html).toContain('data-testid="reject-action"');
  });

  // F119 round-4 B10 — the failed thread read logged only `reason: kind`; a
  // server_error carries its error class, and the line now does too.
  it('a thread read that fails with a server_error logs its error class, as the warnings read does', async () => {
    findByIdMock.mockResolvedValue(makeBroadcast({ status: 'in_design', currentRound: 1 }));
    const { listBroadcastVersions } = await import('@/modules/broadcasts');
    vi.mocked(listBroadcastVersions).mockResolvedValueOnce({ ok: false, error: { kind: 'server_error', errKind: 'TypeError' } } as never);
    const { logger } = await import('@/lib/logger');
    await renderPage();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'server_error', err: 'TypeError', errorId: 'M119.admin.detail.thread' }),
      'broadcasts.detail_page.thread_read_failed',
    );
  });

  // PR #392 review C2 — the thread is read for a closed / approved E-Blast
  // that ran a round too (its history), so a failed read there must say so,
  // not show an empty history. `approvedAt: null` isolates the `round >= 1` arm.
  it('a failed thread read on a sent E-Blast that ran a round shows the unavailable alert', async () => {
    findByIdMock.mockResolvedValue(makeBroadcast({ status: 'sent', currentRound: 1, approvedAt: null }));
    const { listBroadcastVersions } = await import('@/modules/broadcasts');
    vi.mocked(listBroadcastVersions).mockResolvedValueOnce({ ok: false, error: { kind: 'server_error', errKind: 'TypeError' } } as never);
    const html = await renderPage();
    expect(vi.mocked(listBroadcastVersions)).toHaveBeenCalledTimes(1);
    expect(html).toContain('data-testid="eblast-thread-unavailable"');
  });

  // PR #392 review D7 — on a stage with no working copy (approved / sent /
  // cancelled …) the alert claimed "the working copy and the member's
  // original are not shown, and no formatting action is available", none of
  // which applies there; and it offered no way to retry. It says only what
  // failed there, and both variants carry a Refresh button, as the portal's.
  it.each([
    ['a sent E-Blast (no working copy)', { status: 'sent', currentRound: 1, approvedAt: null }, 'threadUnavailableHistoryBody'],
    ['an E-Blast in design (a working copy)', { status: 'in_design', currentRound: 1 }, 'threadUnavailableBody'],
  ] as const)('D7: %s — the unavailable alert names what failed there and offers Refresh', async (_label, row, bodyKey) => {
    findByIdMock.mockResolvedValue(makeBroadcast(row));
    const { listBroadcastVersions } = await import('@/modules/broadcasts');
    vi.mocked(listBroadcastVersions).mockResolvedValueOnce({ ok: false, error: { kind: 'server_error', errKind: 'TypeError' } } as never);
    const html = await renderPage();
    const alert = html.indexOf('data-testid="eblast-thread-unavailable"');
    expect(alert).toBeGreaterThan(-1);
    const alertHtml = html.slice(alert, html.indexOf('data-testid="refresh-page-button"', alert));
    expect(alertHtml).toContain(`>${bodyKey}<`);
    expect(html.indexOf('data-testid="refresh-page-button"', alert)).toBeGreaterThan(alert);
  });

  it('a submitted broadcast that renders keeps its Approve / Reject actions', async () => {
    const html = await renderPage();
    expect(html).toContain('data-testid="approve-action"');
    expect(html).toContain('data-testid="reject-action"');
    // Positive control for the case below: the Cancel slot does render.
    expect(html).toContain('data-testid="cancel-action"');
  });

  /**
   * F119 T051 + B1 — the five 0308 stages must not inherit today's Approve:
   * it is approve-AS-SUBMITTED, so it stays `submitted`-only. Reject follows
   * the Domain `canTransition(status, 'rejected')` (T081 widened it), and
   * Cancel the Domain `canCancel` — the same policies the `/reject` and
   * `/cancel` use cases enforce — so a button can never offer what the server
   * would refuse. Derived, not hard-coded.
   */
  it.each([
    'in_design',
    'awaiting_member_approval',
    'changes_requested',
    'member_approved',
    'expired_no_member_response',
  ] as const)('%s shows no Approve, Reject only if canTransition admits it, Cancel only if canCancel does', async (status) => {
    findByIdMock.mockResolvedValue(makeBroadcast({ status }));
    const html = await renderPage();
    expect(html).not.toContain('data-testid="approve-action"');
    expect(html.includes('data-testid="reject-action"')).toBe(canTransition(status, 'rejected'));
    expect(html.includes('data-testid="cancel-action"')).toBe(canCancel(status));
  });

  /**
   * The finding itself, with no stubs in the way: one stored body, two
   * renderers. What the approver used to see is the second column.
   */
  it('the delivered document turns a CTA marker into a bgcolor table; the raw sanitiser leaves a bare link', async () => {
    const delivered = await renderBroadcastPreview(
      { sanitizer: dompurifySanitizer, brand: { load: async () => ({ primaryColor: '#123456' as BrandHexColor, postalAddress: null, logoUrl: null }) }, renderer: emailTemplateRenderer },
      {
        tenantId: 'tenant-a' as never,
        tenantDisplayName: 'Tenant A',
        subject: SUBJECT,
        bodyHtml: CTA_BODY,
        locale: 'en',
        surface: 'detail',
      },
    );

    expect(delivered.ok).toBe(true);
    if (delivered.ok) {
      expect(delivered.value.html).toContain('bgcolor');
      expect(delivered.value.html).toContain('#123456');
    }

    // The path the page used to take produces neither.
    const rawOnly = dompurifySanitizer.sanitize(CTA_BODY);
    expect(rawOnly).not.toContain('bgcolor');
    expect(rawOnly).toContain('href="https://example.org/go"');
  });
});
