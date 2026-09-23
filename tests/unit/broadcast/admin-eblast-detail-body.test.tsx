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
vi.mock('@/components/broadcast/admin/review-actions', () => ({
  ReviewActions: () => <div data-testid="review-actions" />,
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

const findByIdMock = vi.fn();
const renderBroadcastPreviewMock = vi.fn();
// F119 T051 — the page gates Cancel on the Domain `canCancel`; the real
// policy, not a copy of its rule.
vi.mock('@/modules/broadcasts', async () => ({
  canCancel: (
    await vi.importActual<typeof import('@/modules/broadcasts/domain/policies/cancel-cutoff-policy')>(
      '@/modules/broadcasts/domain/policies/cancel-cutoff-policy',
    )
  ).canCancel,
  makeGetBroadcastDeps: () => ({ broadcastsRepo: { findById: findByIdMock } }),
  parseBroadcastId: (id: string) => ({ ok: true as const, value: id }),
  renderBroadcastPreview: (...args: unknown[]) => renderBroadcastPreviewMock(...args),
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
    // Staff must not sign off on content the server could not render.
    expect(html).not.toContain('data-testid="review-actions"');
  });

  it('a submitted broadcast that renders keeps its Approve / Reject actions', async () => {
    const html = await renderPage();
    expect(html).toContain('data-testid="review-actions"');
    // Positive control for the case below: the Cancel slot does render.
    expect(html).toContain('data-testid="cancel-action"');
  });

  /**
   * F119 T051 — the five 0305 stages must not inherit today's CTAs. Approve /
   * Reject stay `submitted`-only (the approval-round actions are their own
   * tasks), and Cancel follows the Domain `canCancel` — the same policy the
   * `/cancel` use case enforces — so the button can never offer what the
   * server would refuse. Derived, not hard-coded: T081 widens the policy and
   * this keeps holding.
   */
  it.each([
    'in_design',
    'awaiting_member_approval',
    'changes_requested',
    'member_approved',
    'expired_no_member_response',
  ] as const)('%s shows no Approve / Reject, and Cancel only if canCancel admits it', async (status) => {
    findByIdMock.mockResolvedValue(makeBroadcast({ status }));
    const html = await renderPage();
    expect(html).not.toContain('data-testid="review-actions"');
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
