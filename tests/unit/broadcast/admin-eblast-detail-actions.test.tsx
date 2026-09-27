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
/** F119 PR-A — keys the mocked catalogue does NOT hold, so `t.has` can answer false. */
let missingKeys = new Set<string>();

vi.mock('next/link', () => ({
  default: ({ children }: { children?: ReactNode }) => children as ReactElement,
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
// PR #392 review D7 — the thread-unavailable alert's Refresh (a client island).
vi.mock('@/components/shell/refresh-page-button', () => ({
  RefreshPageButton: ({ label }: { label: string }) => <button data-testid="refresh-page-button">{label}</button>,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue(
    Object.assign((key: string) => key, { has: (key: string) => !missingKeys.has(key) }),
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
  makeReadDispatchHoldDeps: () => ({}),
}));
vi.mock('@/components/shell/relative-time', () => ({ RelativeTime: () => <time /> }));
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
vi.mock('@/components/broadcast/approval/start-formatted-version-action', () => ({
  StartFormattedVersionAction: (p: { confirm: string }) => <div data-testid="start-version" data-confirm={p.confirm} />,
}));
vi.mock('@/components/broadcast/approval/schedule-confirm-dialog', () => ({
  ScheduleConfirmAction: () => <div data-testid="confirm-schedule" />,
}));
vi.mock('@/components/broadcast/approval/formatted-version-workspace', () => ({
  FormattedVersionWorkspace: () => <div data-testid="format-workspace" />,
}));
vi.mock('@/components/broadcast/admin/audit-timeline', () => ({ AuditTimeline: () => null }));
// F119 T085 — the REAL staff model builder; the thread itself is a marker that
// echoes each round's decision reasons (`v<no>:<reason>|<reason>`).
vi.mock('@/components/broadcast/approval/version-thread', async () => {
  const actual = await vi.importActual<typeof import('@/components/broadcast/approval/version-thread')>(
    '@/components/broadcast/approval/version-thread',
  );
  return {
    ...actual,
    VersionThread: (p: { model: import('@/components/broadcast/approval/version-thread').VersionThreadModel }) => (
      <div data-testid="version-thread">
        {p.model.rounds.map((r) => `v${r.version.versionNo}:${r.decisions.map((d) => d.reason).join('|')}`).join(';')}
        {p.model.approvedAsSubmitted !== null && p.model.approvedAsSubmitted.author.side === 'organisation'
          ? `as-submitted:${p.model.approvedAsSubmitted.author.name ?? ''}`
          : ''}
      </div>
    ),
  };
});
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
/** F119 PR-A R1 — the page's "held for the member's payment" read; default: not held. */
const holdMock = vi.fn(async (..._args: unknown[]): Promise<{ ok: true; value: boolean }> => ({ ok: true, value: false }));
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
  const transitions = await vi.importActual<
    typeof import('@/modules/broadcasts/domain/policies/broadcast-status-transitions')
  >('@/modules/broadcasts/domain/policies/broadcast-status-transitions');
  return {
    canCancel: cutoff.canCancel,
    canTransition: transitions.canTransition,
    stageOf: stage.stageOf,
    turnOf: turn.turnOf,
    isEblastMemberApprovalEnabled: () => flagOn,
    isF71aUs2Enabled: () => false,
    makeGetBroadcastDeps: () => ({ broadcastsRepo: { findById: findByIdMock } }),
    parseBroadcastId: (id: string) => ({ ok: true as const, value: id }),
    listBroadcastVersions: (...args: unknown[]) => listVersionsMock(...args),
    readFormattingWarnings: (...args: unknown[]) => warningsMock(...args),
    readDispatchHold: (...args: unknown[]) => holdMock(...args),
  };
});

const ID = '11111111-1111-4111-8111-111111111111';
const V0 = {
  id: 'aaaaaaaa-0000-4000-8000-000000000000',
  versionNo: 0,
  subject: 'Original subject',
  bodyHtml: '<p>original</p>',
  noteToMember: null,
  authoredByRole: 'member_self_service',
  sentToMemberAt: new Date('2026-09-20T08:00:00Z'),
  createdAt: new Date('2026-09-20T08:00:00Z'),
  updatedAt: new Date('2026-09-20T08:00:00Z'),
};
const V1 = {
  ...V0,
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  versionNo: 1,
  authoredByRole: 'admin_proxy',
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
    approvedAt: null,
    ...over,
  };
}

let decisions: Array<Record<string, unknown>> = [];

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
      decisions,
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
    decisions = [];
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
    expect(has(html, 'approve-action')).toBe(true);
    expect(has(html, 'reject-action')).toBe(true);
  });

  /**
   * F119 B1 — T081 widened reject to every pre-send stage but `approved`
   * (which has no rejected edge). Approve here is approve-AS-SUBMITTED, so it
   * stays `submitted`-only; Reject follows the Domain `canTransition`.
   */
  it.each([
    ['in_design', 0],
    ['awaiting_member_approval', 1],
    ['changes_requested', 1],
    ['member_approved', 1],
  ] as const)('%s → Reject is offered, Approve is not', async (status, round) => {
    const html = await renderPage(status, round);
    expect(has(html, 'reject-action')).toBe(true);
    expect(has(html, 'approve-action')).toBe(false);
  });

  it.each([
    ['approved', 0],
    ['approved', 1],
  ] as const)('%s (round %s) → neither Approve nor Reject (no rejected edge)', async (status, round) => {
    const html = await renderPage(status, round);
    expect(has(html, 'reject-action')).toBe(false);
    expect(has(html, 'approve-action')).toBe(false);
    expect(has(html, 'review-actions')).toBe(false);
  });

  it('a manager is offered neither half on any stage that could reject (absent, not disabled)', async () => {
    role = 'manager';
    for (const [status, round] of [['submitted', 0], ['awaiting_member_approval', 1], ['member_approved', 1]] as const) {
      expect(has(await renderPage(status, round), 'review-actions'), status).toBe(false);
    }
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

  /** M3 — what starting costs from each stage, which is what the island asks (or not) before it posts. */
  it.each([
    ['submitted', 0, 'leaves_submitted'],
    ['changes_requested', 1, 'none'],
    ['member_approved', 1, 'voids_approval'],
    ['approved', 1, 'voids_approval'],
  ] as const)('%s (round %s) → Start asks: %s', async (status, round, confirm) => {
    expect(await renderPage(status, round)).toContain(`data-confirm="${confirm}"`);
  });

  /** M1 — the standing warnings are persistent page content, not live announcements. */
  it('the standing warnings are notes, not status live regions', async () => {
    warningsMock.mockResolvedValue({
      ok: true,
      value: { hasPortalUser: false, unsafeImages: [{ src: 'https://evil.example/x.png', reason: 'not_allowlisted' }] },
    });
    const html = await renderPage('changes_requested', 1);
    for (const testId of ['eblast-warning-no-portal-user', 'eblast-warning-unsafe-images']) {
      const tag = html.slice(html.lastIndexOf('<div', html.indexOf(`data-testid="${testId}"`)), html.indexOf(`data-testid="${testId}"`));
      expect(tag, testId).toContain('role="note"');
    }
    expect(html).not.toContain('role="status" data-testid="eblast-warning');
  });

  /** M2 — "Not sent to the member yet" only where a version could still be sent. */
  it('approved as submitted (round 0) does not claim the E-Blast is "not sent to the member yet"', async () => {
    const html = await renderPage('approved', 0);
    expect(html).not.toContain('roundNone');
    expect(html).toContain('roundNoRound');
  });

  it('submitted with the flag off shows no Round row (there is no approval round to speak of)', async () => {
    flagOn = false;
    expect(has(await renderPage('submitted'), 'eblast-round')).toBe(false);
  });

  it('submitted with the flag on, and in_design, keep "not sent to the member yet"', async () => {
    expect(await renderPage('submitted')).toContain('roundNone');
    expect(await renderPage('in_design')).toContain('roundNone');
  });

  /** LOW — an empty sentinel is muted, and "whose turn" names nobody for AT. */
  it('nobody\'s turn → a muted dash for sight and a word for AT', async () => {
    const html = await renderPage('approved', 0);
    const cell = html.slice(html.indexOf('data-testid="eblast-whose-turn"'), html.indexOf('</dd>', html.indexOf('data-testid="eblast-whose-turn"')));
    expect(cell).toContain('<span aria-hidden="true" class="text-muted-foreground">—</span>');
    expect(cell).toContain('<span class="sr-only">turnValue.none</span>');
  });

  /**
   * F119 T085 — the version thread (FR-011, FR-032): every decision and its
   * reason, attached to the version it concerns, on every stage that carries
   * a round — for a manager too.
   */
  it.each([
    ['changes_requested', 1],
    ['in_design', 1],
    ['member_approved', 1],
  ] as const)('%s (round %s) → the version thread, with every reason', async (status, round) => {
    decisions = [
      { id: 'd0', versionId: V1.id, round: 1, decision: 'approved', reason: 'Looks good', decidedAt: new Date('2026-09-21T08:00:00Z') },
      { id: 'd1', versionId: V1.id, round: 1, decision: 'approval_withdrawn', reason: 'The date in the heading is wrong', decidedAt: new Date('2026-09-22T08:00:00Z') },
    ];
    role = 'manager';
    const html = await renderPage(status, round);
    expect(has(html, 'version-thread')).toBe(true);
    // Both reasons, on version 1 — the thread keeps the whole history, not the latest line.
    expect(html).toContain('v1:Looks good|The date in the heading is wrong');
    // The unsent working copy is never a round of the thread.
    expect(html).not.toContain('v2:');
  });

  /**
   * UX review M6 — the member's LATEST request stays in view ABOVE what
   * marketing works on, as a note; the full thread sits BELOW it, so a long
   * history never pushes the editor below the fold.
   */
  it.each([
    ['changes_requested', 'admin', 'eblast-version-comparison'],
    ['in_design', 'admin', 'format-workspace'],
    ['in_design', 'manager', 'eblast-version-comparison'],
  ] as const)('%s as %s → the latest request above the %s, the thread below it', async (status, who, workTestId) => {
    decisions = [
      { id: 'd0', versionId: V1.id, round: 1, decision: 'approved', reason: 'Looks good', decidedAt: new Date('2026-09-21T08:00:00Z') },
      { id: 'd1', versionId: V1.id, round: 1, decision: 'changes_requested', reason: 'The date in the heading is wrong', decidedAt: new Date('2026-09-22T08:00:00Z') },
    ];
    role = who;
    const html = await renderPage(status, 1);
    const note = html.indexOf('data-testid="eblast-member-feedback"');
    const work = html.indexOf(`data-testid="${workTestId}"`);
    const thread = html.indexOf('data-testid="version-thread"');
    expect(note).toBeGreaterThan(-1);
    expect(html.slice(html.lastIndexOf('<div', note), note)).toContain('role="note"');
    expect(html.slice(note, work)).toContain('The date in the heading is wrong');
    expect(work).toBeGreaterThan(note);
    expect(thread).toBeGreaterThan(work);
  });

  it('the latest-request note names who asked when the name is known (FR-032), else "the member"', async () => {
    decisions = [{ id: 'd1', versionId: V1.id, round: 1, decision: 'changes_requested', reason: 'x', decidedByName: 'Anna Andersson', decidedAt: new Date('2026-09-22T08:00:00Z') }];
    const named = await renderPage('changes_requested', 1);
    const at = named.indexOf('data-testid="eblast-member-feedback"');
    expect(named.slice(at, named.indexOf('</div>', at))).toContain('changesRequestedBy');
    decisions = [{ id: 'd1', versionId: V1.id, round: 1, decision: 'changes_requested', reason: 'x', decidedAt: new Date('2026-09-22T08:00:00Z') }];
    const unnamed = await renderPage('changes_requested', 1);
    const at2 = unnamed.indexOf('data-testid="eblast-member-feedback"');
    expect(unnamed.slice(at2, unnamed.indexOf('</div>', at2))).toContain('changesRequestedTitle');
  });

  it('no latest-request note when the latest decision is an approval, when there is none, or once the member approved', async () => {
    decisions = [{ id: 'd0', versionId: V1.id, round: 1, decision: 'approved', reason: 'Looks good', decidedAt: new Date('2026-09-21T08:00:00Z') }];
    expect(has(await renderPage('changes_requested', 1), 'eblast-member-feedback')).toBe(false);
    decisions = [];
    expect(has(await renderPage('changes_requested', 1), 'eblast-member-feedback')).toBe(false);
    decisions = [{ id: 'd1', versionId: V1.id, round: 1, decision: 'changes_requested', reason: 'x', decidedAt: new Date('2026-09-22T08:00:00Z') }];
    expect(has(await renderPage('member_approved', 1), 'eblast-member-feedback')).toBe(false);
  });

  it('approved as submitted (round 0) → the single "approved as submitted" entry, with the staff name (FR-007)', async () => {
    findByIdMock.mockResolvedValue(
      makeBroadcast({ status: 'approved', currentRound: 0, approvedAt: new Date('2026-09-21T08:00:00Z') }),
    );
    listVersionsMock.mockResolvedValue({
      ok: true,
      value: {
        ...threadFor('approved', 0).value,
        approvedVersionId: null,
        memberOriginal: null,
        approvedAsSubmitted: { at: new Date('2026-09-21T08:00:00Z'), byUserId: 'staff-9', byUserName: 'Karin Lindqvist' },
      },
    });
    const Page = (await import('@/app/(staff)/admin/broadcasts/[id]/page')).default;
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: ID }) }));
    expect(has(html, 'version-thread')).toBe(true);
    expect(html).toContain('as-submitted:Karin Lindqvist');
  });

  it('an E-Blast with no round and no approval shows no thread', async () => {
    const html = await renderPage('submitted');
    expect(has(html, 'version-thread')).toBe(false);
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

/**
 * F119 PR-A — "marketing sees why it is blocked": a `failed_to_dispatch` row
 * says WHY under its status. The reason was stored (`failure_reason`) and shown
 * nowhere, so staff could not tell a member refused at send time (halted,
 * suspended) from a Resend outage without reading the audit log.
 */
describe('F119 PR-A — the staff detail page shows why an E-Blast was not sent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    role = 'admin';
    flagOn = true;
    decisions = [];
    missingKeys = new Set();
    warningsMock.mockResolvedValue({ ok: true, value: { hasPortalUser: true, unsafeImages: [] } });
  });

  async function renderFailed(failureReason: string | null, status = 'failed_to_dispatch'): Promise<string> {
    findByIdMock.mockResolvedValue(makeBroadcast({ status, failureReason }));
    listVersionsMock.mockResolvedValue(threadFor(status, 0));
    const Page = (await import('@/app/(staff)/admin/broadcasts/[id]/page')).default;
    return renderToStaticMarkup(await Page({ params: Promise.resolve({ id: ID }) }));
  }

  /** The reason block's own text (the mocked `t` echoes the key it was asked for). */
  function reasonBlock(html: string): string {
    const at = html.indexOf('data-testid="eblast-failure-reason"');
    expect(at, 'the reason block is rendered').toBeGreaterThan(-1);
    // From the block's own opening tag, so its attributes (`role`, …) are in view.
    return html.slice(html.lastIndexOf('<div', at), html.indexOf('</div></div>', at));
  }

  it.each(['member_halted', 'member_not_in_good_standing', 'audience_import_stuck'] as const)(
    'failed_to_dispatch (%s) → the reason sentence for that token, as a note in body text',
    async (reason) => {
      const html = await renderFailed(reason);
      const block = reasonBlock(html);
      expect(block).toContain('role="note"');
      expect(block).toContain('failureReasonTitle');
      expect(block).toContain(`failureReason.${reason}`);
      // Body text, not the muted empty-sentinel colour; never italic (Thai).
      expect(block).toContain('text-foreground');
      expect(block).not.toMatch(/text-muted-foreground|italic/);
    },
  );

  it('a composite stored reason (the legacy leg writes `<token>:<detail>`) reads its token, never the detail', async () => {
    const block = reasonBlock(await renderFailed('retry_budget_exhausted_after_1h:server_5xx:upstream said no'));
    expect(block).toContain('failureReason.retry_budget_exhausted');
    expect(block).not.toContain('upstream said no');
    const missing = reasonBlock(await renderFailed('resend_resource_missing:audience'));
    expect(missing).toContain('failureReason.resend_resource_missing');
  });

  it('free text, an unknown token or a NULL reason → the generic sentence, and the raw value never reaches the page', async () => {
    missingKeys = new Set(['failureReason.a_token_nobody_wrote']);
    expect(reasonBlock(await renderFailed('a_token_nobody_wrote'))).toContain('failureReason.generic');
    const raw = reasonBlock(await renderFailed('Resend said: 422 invalid from address <x@y.z>'));
    expect(raw).toContain('failureReason.generic');
    expect(raw).not.toContain('x@y.z');
    expect(reasonBlock(await renderFailed(null))).toContain('failureReason.generic');
  });

  it('only a failed_to_dispatch row carries the block', async () => {
    for (const status of ['approved', 'sent', 'cancelled', 'rejected'] as const) {
      expect(has(await renderFailed('member_halted', status), 'eblast-failure-reason'), status).toBe(false);
    }
  });

  /**
   * R6.7 — the two STANDING refusals are decisions about the member (warning);
   * every other token is a delivery failure (destructive). The sentence gets
   * Thai-safe line height: Thai diacritics clip at the default `text-sm`
   * leading.
   */
  it.each([
    ['member_halted', 'warning'],
    ['member_not_in_good_standing', 'warning'],
    ['audience_import_stuck', 'destructive'],
    ['gateway_permanent', 'destructive'],
    ['retry_budget_exhausted_after_1h:server_5xx:x', 'destructive'],
  ] as const)('failed_to_dispatch (%s) → tone %s, relaxed leading', async (reason, tone) => {
    const block = reasonBlock(await renderFailed(reason));
    expect(block).toContain(`data-tone="${tone}"`);
    expect(block).toContain('leading-relaxed');
  });
});

/**
 * F119 PR-A R1 — a due `approved` E-Blast whose member's membership is
 * `suspended` (awaiting payment) is HELD by the dispatch cron every tick. Staff
 * see why it has not gone out, and what happens next.
 */
describe('F119 PR-A — the staff detail page says when a due E-Blast is held for payment', () => {
  const PAST = new Date(Date.now() - 3_600_000);

  beforeEach(() => {
    vi.clearAllMocks();
    role = 'admin';
    flagOn = true;
    decisions = [];
    missingKeys = new Set();
    warningsMock.mockResolvedValue({ ok: true, value: { hasPortalUser: true, unsafeImages: [] } });
    holdMock.mockResolvedValue({ ok: true, value: false });
  });

  async function renderApproved(): Promise<string> {
    findByIdMock.mockResolvedValue(makeBroadcast({ status: 'approved', scheduledFor: PAST, approvedAt: PAST }));
    listVersionsMock.mockResolvedValue(threadFor('approved', 0));
    const Page = (await import('@/app/(staff)/admin/broadcasts/[id]/page')).default;
    return renderToStaticMarkup(await Page({ params: Promise.resolve({ id: ID }) }));
  }

  it('held → an info note with the held title and sentence, and the read names the row and the member', async () => {
    holdMock.mockResolvedValue({ ok: true, value: true });
    const html = await renderApproved();

    expect(has(html, 'eblast-dispatch-held')).toBe(true);
    const at = html.indexOf('data-testid="eblast-dispatch-held"');
    const block = html.slice(html.lastIndexOf('<div', at), html.indexOf('</div></div>', at));
    expect(block).toContain('role="note"');
    expect(block).toContain('data-tone="info"');
    expect(block).toContain('dispatchHeldTitle');
    expect(block).toContain('dispatchHeldBody');
    expect(holdMock).toHaveBeenCalledWith(
      expect.anything(),
      { status: 'approved', scheduledFor: PAST, memberId: 'member-1' },
    );
  });

  it('not held → no note', async () => {
    expect(has(await renderApproved(), 'eblast-dispatch-held')).toBe(false);
  });

  it('the read FAILS → no note (never "held" on a guess), and the failure is logged', async () => {
    holdMock.mockResolvedValue({ ok: false, error: { kind: 'server_error', errClass: 'Error' } } as never);
    const html = await renderApproved();
    expect(has(html, 'eblast-dispatch-held')).toBe(false);
    const { logger } = await import('@/lib/logger');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorId: 'M119.admin.detail.dispatch_hold', err: 'Error' }),
      'broadcasts.detail_page.dispatch_hold_read_failed',
    );
  });
});
