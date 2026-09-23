/**
 * F119 T063 — which action controls the staff detail page
 * `/admin/broadcasts/[id]` renders, per role, stage and flag.
 *
 *   - A `manager` holds `broadcasts.read` only: every action control is
 *     ABSENT, not disabled (contract § Page contracts, US4-AS6). The page asks
 *     the RBAC evaluator (`canPerform`), never `ROLE_BUNDLES`.
 *   - "Start formatted version" is FLAG-GATED as an affordance on `submitted`
 *     only (T152 — the use case is the gate); from `changes_requested`, and
 *     from `member_approved` / `approved` once a round has run, the route
 *     answers 201 in both flag states (FR-034), so the control is there
 *     regardless of the flag.
 *   - Approve / Reject stay `submitted`-only; with the flag off,
 *     approve-as-submitted is the only path (FR-007, FR-034).
 *
 * The islands are mocked to marker elements: this file measures the SERVER
 * page's decision to mount them, which is where "absent" is decided.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';

let role = 'admin';
let flagOn = false;

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
// The evaluator's answer for the two keys the page asks about: a `manager`
// holds neither `broadcasts.write` nor `broadcasts.send`.
vi.mock('@/lib/rbac', () => ({
  requirePagePermission: vi.fn(async () => ({ user: { id: 'staff-1', role } })),
  canPerform: (r: string, key: string) =>
    r !== 'manager' && (key === 'broadcasts.write' || key === 'broadcasts.send'),
}));
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async () => [{ company_name: 'Northern Lights Co' }]),
}));
vi.mock('@/lib/broadcast-detail-body', () => ({
  renderBroadcastDetailBody: vi.fn(async () => ({ status: 'ready', html: '<p>x</p>' })),
}));
vi.mock('@/lib/broadcast-approval-deps', () => ({
  makeListBroadcastVersionsDeps: () => ({}),
  makeReadFormattingWarningsDeps: () => ({}),
}));
vi.mock('@/components/ui/relative-time', () => ({ RelativeTime: () => <time /> }));
vi.mock('@/components/broadcast/cancel-broadcast-action', () => ({
  CancelBroadcastAction: () => <div data-testid="cancel-action" />,
}));
vi.mock('@/components/broadcast/admin/review-actions', () => ({
  ReviewActions: () => <div data-testid="review-actions" />,
}));
vi.mock('@/components/broadcast/approval/start-formatted-version-action', () => ({
  StartFormattedVersionAction: () => <div data-testid="start-version" />,
}));
vi.mock('@/components/broadcast/approval/schedule-confirm-dialog', () => ({
  ScheduleConfirmAction: () => <div data-testid="confirm-schedule" />,
}));
vi.mock('@/components/broadcast/approval/formatted-version-workspace', () => ({
  FormattedVersionWorkspace: () => <div data-testid="format-workspace" />,
}));
vi.mock('@/components/broadcast/admin/audit-timeline', () => ({ AuditTimeline: () => null }));
vi.mock('@/components/broadcast/admin/status-badge', () => ({
  StatusBadge: () => <span data-testid="status-badge" />,
}));
vi.mock('@/components/broadcast/admin/manager-readonly-banner', () => ({
  ManagerReadonlyBanner: () => <div data-testid="manager-banner" />,
}));
vi.mock('@/components/broadcast/use-preview-html', () => ({
  PreviewSurface: () => <div data-testid="preview-surface" />,
}));

const findByIdMock = vi.fn();
const listVersionsMock = vi.fn();
const warningsMock = vi.fn();
vi.mock('@/modules/broadcasts', async () => {
  const cutoff = await vi.importActual<typeof import('@/modules/broadcasts/domain/policies/cancel-cutoff-policy')>(
    '@/modules/broadcasts/domain/policies/cancel-cutoff-policy',
  );
  const stage = await vi.importActual<typeof import('@/modules/broadcasts/domain/stage/broadcast-stage')>(
    '@/modules/broadcasts/domain/stage/broadcast-stage',
  );
  const turn = await vi.importActual<typeof import('@/modules/broadcasts/domain/stage/whose-turn')>(
    '@/modules/broadcasts/domain/stage/whose-turn',
  );
  return {
    canCancel: cutoff.canCancel,
    stageOf: stage.stageOf,
    turnOf: turn.turnOf,
    isEblastMemberApprovalEnabled: () => flagOn,
    isF71aUs2Enabled: () => false,
    makeGetBroadcastDeps: () => ({ broadcastsRepo: { findById: findByIdMock } }),
    parseBroadcastId: (id: string) => ({ ok: true as const, value: id }),
    listBroadcastVersions: (...args: unknown[]) => listVersionsMock(...args),
    readFormattingWarnings: (...args: unknown[]) => warningsMock(...args),
  };
});

const ID = '11111111-1111-4111-8111-111111111111';
const V0 = {
  id: 'aaaaaaaa-0000-4000-8000-000000000000',
  versionNo: 0,
  subject: 'Original subject',
  bodyHtml: '<p>original</p>',
  noteToMember: null,
  sentToMemberAt: new Date('2026-09-20T08:00:00Z'),
  updatedAt: new Date('2026-09-20T08:00:00Z'),
};
const V1 = {
  ...V0,
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  versionNo: 1,
  subject: 'Formatted subject',
  bodyHtml: '<p>formatted</p>',
};

function makeBroadcast(over: Record<string, unknown> = {}) {
  return {
    broadcastId: ID,
    subject: 'Original subject',
    bodyHtml: '<p>original</p>',
    status: 'submitted',
    actorRole: 'member_self_service',
    segmentType: 'all_members',
    estimatedRecipientCount: 42,
    requestedByMemberId: 'member-1',
    submittedAt: new Date('2026-09-01T03:00:00.000Z'),
    scheduledFor: null,
    proposedSendAt: new Date('2026-10-01T03:00:00.000Z'),
    stageEnteredAt: new Date('2026-09-20T03:00:00.000Z'),
    currentRound: 0,
    approvedVersionId: null,
    ...over,
  };
}

/** The thread for a stage: in_design carries an unsent working copy. */
function threadFor(status: string, round: number) {
  const working = { ...V1, versionNo: round + 1, sentToMemberAt: null };
  return {
    ok: true as const,
    value: {
      broadcastId: ID,
      status,
      stage: status,
      round,
      approvedVersionId: status === 'member_approved' || status === 'approved' ? V1.id : null,
      memberOriginal: { version: V0, authoredByName: null },
      sentVersions: round >= 1 ? [{ version: V1, authoredByName: 'Marketing' }] : [],
      workingCopy: status === 'in_design' ? { version: working, authoredByName: 'Marketing' } : null,
      decisions: [],
      approvedAsSubmitted: null,
    },
  };
}

async function renderPage(status: string, round = 0): Promise<string> {
  findByIdMock.mockResolvedValue(makeBroadcast({ status, currentRound: round }));
  listVersionsMock.mockResolvedValue(threadFor(status, round));
  const Page = (await import('@/app/(staff)/admin/broadcasts/[id]/page')).default;
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ id: ID }) }));
}

const has = (html: string, testId: string): boolean => html.includes(`data-testid="${testId}"`);
const ACTION_CONTROLS = [
  'start-version',
  'confirm-schedule',
  'format-workspace',
  'review-actions',
  'cancel-action',
  'eblast-action-row',
] as const;

describe('F119 T063 — the staff detail page action controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    role = 'admin';
    flagOn = true;
    warningsMock.mockResolvedValue({ ok: true, value: { hasPortalUser: true, unsafeImages: [] } });
  });

  it.each([
    ['submitted', 0],
    ['in_design', 0],
    ['changes_requested', 1],
    ['member_approved', 1],
    ['approved', 1],
  ] as const)('a manager sees no action control (%s)', async (status, round) => {
    role = 'manager';
    const html = await renderPage(status, round);
    for (const control of ACTION_CONTROLS) expect(has(html, control), control).toBe(false);
    // …while the read-only surfaces are there: the banner, and on in_design
    // the working copy beside the member's original.
    expect(has(html, 'manager-banner')).toBe(true);
    if (status === 'in_design') expect(has(html, 'eblast-version-comparison')).toBe(true);
  });

  it('an admin on the same stages does see them (positive control)', async () => {
    expect(has(await renderPage('submitted'), 'review-actions')).toBe(true);
    expect(has(await renderPage('in_design'), 'format-workspace')).toBe(true);
    expect(has(await renderPage('member_approved', 1), 'confirm-schedule')).toBe(true);
  });

  it('submitted + flag off → no Start button, and approve-as-submitted stays', async () => {
    flagOn = false;
    const html = await renderPage('submitted');
    expect(has(html, 'start-version')).toBe(false);
    expect(has(html, 'review-actions')).toBe(true);
  });

  it('submitted + flag on → Start button', async () => {
    expect(has(await renderPage('submitted'), 'start-version')).toBe(true);
  });

  it('changes_requested + flag off → Start present (the route answers 201 in both flag states)', async () => {
    flagOn = false;
    expect(has(await renderPage('changes_requested', 1), 'start-version')).toBe(true);
  });

  it.each(['member_approved', 'approved'] as const)(
    '%s with a round → Start (voids the approval) and the schedule control, in both flag states',
    async (status) => {
      flagOn = false;
      const html = await renderPage(status, 1);
      expect(has(html, 'start-version')).toBe(true);
      expect(has(html, 'confirm-schedule')).toBe(true);
    },
  );

  it('approved as submitted (round 0) → neither Start nor the schedule control', async () => {
    const html = await renderPage('approved', 0);
    expect(has(html, 'start-version')).toBe(false);
    expect(has(html, 'confirm-schedule')).toBe(false);
    // Cancel still follows the Domain cut-off.
    expect(has(html, 'cancel-action')).toBe(true);
  });

  /**
   * FR-034 — "behave as today" while the flag is off. On `submitted` the
   * no-portal-user warning concerns a formatting round only the flag opens,
   * so with the flag off the page neither reads it nor shows it; an
   * in-flight stage keeps it in both flag states.
   */
  it('submitted + flag off → the standing warnings are not read, and none is shown', async () => {
    flagOn = false;
    warningsMock.mockResolvedValue({ ok: true, value: { hasPortalUser: false, unsafeImages: [] } });
    const html = await renderPage('submitted');
    expect(warningsMock).not.toHaveBeenCalled();
    expect(has(html, 'eblast-warning-no-portal-user')).toBe(false);
  });

  it.each([
    ['submitted', 0, true],
    ['changes_requested', 1, false],
  ] as const)('%s (flag on: %s) with no portal user → the standing warning', async (status, round, on) => {
    flagOn = on;
    warningsMock.mockResolvedValue({ ok: true, value: { hasPortalUser: false, unsafeImages: [] } });
    expect(has(await renderPage(status, round), 'eblast-warning-no-portal-user')).toBe(true);
  });

  it('in_design whose thread cannot be read → an explicit alert, never the record body as if nothing were wrong', async () => {
    findByIdMock.mockResolvedValue(makeBroadcast({ status: 'in_design' }));
    listVersionsMock.mockResolvedValue({ ok: false, error: { kind: 'server_error', errKind: 'TypeError' } });
    const Page = (await import('@/app/(staff)/admin/broadcasts/[id]/page')).default;
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: ID }) }));
    expect(has(html, 'eblast-thread-unavailable')).toBe(true);
    expect(has(html, 'format-workspace')).toBe(false);
  });
});
