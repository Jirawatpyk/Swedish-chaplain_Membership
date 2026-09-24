/**
 * F119 T065 — the approval-round outbox arms (contracts/dashboard-and-
 * notifications.md §§ 3, 6; data-model § 7.3; research R14; FR-021b, SC-004).
 *
 *   1. Every `notification_type` value has a `case` arm in the dispatcher's
 *      `buildPayload` — enumerated from the enum, with a positive control —
 *      because the `default:` arm returns null and a row without an arm
 *      retries silently for ~16 h before failing.
 *   2. The arms render from ids at send time; a STAFF rendering carries the
 *      subject, the member company, the stage and a link, and none of the
 *      body, the member's reason, marketing's note or the send times — with a
 *      positive control that fails when the reason is spliced back in.
 *   3. An `eblast_member_decided_marketing` row with `versionId: null` and
 *      `round: null` (a withdrawal from `submitted`) renders a complete email
 *      and does not throw.
 *   4. SC-004 — every hand-off enqueues its outbox row INSIDE the
 *      state-changing transaction: a commit leaves exactly one row per
 *      recipient, riding the tx `withTx` handed out; a commit failure AFTER
 *      the enqueue leaves zero.
 *
 * The arms run through `buildEblastNotificationPayload` — the composition the
 * three `case` labels in the route delegate to — over the in-memory approval
 * store. The live-Neon halves (the real INSERT rolling back with the real tx,
 * the real tick sending the row) are in
 * `tests/integration/broadcasts/eblast-send-and-promote.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { escapeHtml } from '@/lib/html-escape';
import { notificationTypeEnum } from '@/modules/auth/infrastructure/db/schema';
import { asTenantContext } from '@/modules/tenants';
import type { MemberDecision } from '@/modules/broadcasts/domain/approval/member-decision';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import type { BroadcastVersion } from '@/modules/broadcasts/domain/approval/broadcast-version';
import { formatEblastEmailDate } from '@/modules/broadcasts/infrastructure/email/broadcast-approval-emails';
import { dompurifySanitizer } from '@/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer';
import { sendVersionToMember } from '@/modules/broadcasts/application/use-cases/approval/send-version-to-member';
import { confirmSchedule } from '@/modules/broadcasts/application/use-cases/approval/confirm-schedule';
import { recordMemberDecision } from '@/modules/broadcasts/application/use-cases/approval/record-member-decision';
import {
  buildEblastNotificationPayload,
  type EblastNotificationReads,
  type EblastOutboxRow,
} from '@/lib/broadcast-approval-notifications';
import {
  FAKE_TX,
  makeApprovalBroadcast,
  makeApprovalVersion,
  makeFakeApprovalStore,
  makeFakeImageAllowlist,
  makeFakeMarketingDirectory,
  makeFakePortalRecipients,
  makeMarketingRecipient,
  makePortalContact,
  makeRecordingF7Audit,
  type FakeApprovalStore,
} from '../../helpers/eblast-approval-fakes';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const ROOT = join(__dirname, '..', '..', '..');
const TENANT = 'test-tenant';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const BROADCAST_ID = '11111111-1111-4111-8111-111111111111';
const V1 = 'aaaaaaaa-0000-4000-8000-000000000001';
/** `makeMarketingRecipient()`'s user id — the roster member a decided row names. */
const MARKETER_ID = '44444444-4444-4444-8444-444444444444';
const COMPANY = 'Nordic Trading Co., Ltd.';
const SENT_AT = new Date('2026-09-21T08:00:00.000Z');
const PROPOSED = new Date('2026-10-01T03:00:00.000Z');
const CONFIRMED = new Date('2026-10-02T05:30:00.000Z');

const BODY = '<p>SECRET-BODY-7f3a</p>';
const REASON = 'SECRET-REASON-91c2 change the logo';
const NOTE = 'SECRET-NOTE-44de check the date';

// ---------------------------------------------------------------------------
// 1. Every notification_type value has an arm
// ---------------------------------------------------------------------------

/**
 * Types whose arm lands in a LATER PR-2 task. The enqueue already exists or is
 * about to, and the drainer skips them while the flag is off (T152a), so no
 * row can reach the `default:` ladder in prod before the arm lands — but this
 * list MUST BE EMPTY BEFORE PR-2 MERGES (the KNOWN_NOT_YET_EMITTED pattern).
 */
const ARM_NOT_YET_BUILT: Readonly<Record<string, string>> = {
  // Empty since T129 (eblast_submitted_marketing) and T131
  // (eblast_approval_lifecycle) landed their arms — keep it that way.
};

/** Types routed BEFORE `buildPayload` — they are not emails. */
const ROUTED_BEFORE_BUILD_PAYLOAD: Readonly<Record<string, RegExp>> = {
  receipt_pdf_render: /row\.notificationType === 'receipt_pdf_render'/,
};

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function buildPayloadCases(routeSource: string): Set<string> {
  const code = stripComments(routeSource);
  const start = code.indexOf('async function buildPayload(');
  if (start < 0) return new Set();
  const rest = code.slice(start + 1);
  const next = rest.search(/\r?\n(?:async )?function /);
  const body = next < 0 ? rest : rest.slice(0, next);
  return new Set([...body.matchAll(/case\s+'([a-z0-9_]+)'\s*:/g)].map((m) => m[1]!));
}

function missingArms(values: readonly string[], routeSource: string): string[] {
  const cases = buildPayloadCases(routeSource);
  const code = stripComments(routeSource);
  return values.filter((v) => {
    if (cases.has(v)) return false;
    const routed = ROUTED_BEFORE_BUILD_PAYLOAD[v];
    if (routed !== undefined && routed.test(code)) return false;
    return !Object.hasOwn(ARM_NOT_YET_BUILT, v);
  });
}

describe('every notification_type value has a buildPayload arm', () => {
  const route = readFileSync(join(ROOT, 'src', 'app', 'api', 'cron', 'outbox-dispatch', 'route.ts'), 'utf8');
  const values = notificationTypeEnum.enumValues;

  it('enumerated from the enum: no value is arm-less', () => {
    expect(missingArms(values, route)).toEqual([]);
  });

  it('positive control: the parse finds the arms, and a value without one is reported', () => {
    expect(buildPayloadCases(route).size).toBeGreaterThan(10);
    expect(buildPayloadCases(route).has('member_change_request_decided_member')).toBe(true);
    expect(values.filter((v) => v.startsWith('eblast_'))).toHaveLength(5);
    expect(missingArms([...values, 'eblast_fabricated_type'], route)).toEqual(['eblast_fabricated_type']);
    // An arm removed from the source is reported too.
    const armless = route.replace("case 'eblast_version_sent_member':", '');
    expect(missingArms(values, armless)).toEqual(['eblast_version_sent_member']);
  });

  it('the not-yet-built allow-list is not stale: each listed type really has no arm yet', () => {
    const cases = buildPayloadCases(route);
    for (const type of Object.keys(ARM_NOT_YET_BUILT)) {
      expect(values).toContain(type);
      expect(cases.has(type), `${type} has an arm now — delete it from ARM_NOT_YET_BUILT`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2–3. The arms render from ids at send time
// ---------------------------------------------------------------------------

interface ReadsFixture {
  store: FakeApprovalStore;
  reads: EblastNotificationReads;
}

function fixture(
  seed: { broadcasts?: Broadcast[]; versions?: BroadcastVersion[]; decisions?: MemberDecision[] },
  opts: { contacts?: ReturnType<typeof makePortalContact>[]; company?: string | null; roster?: ReturnType<typeof makeMarketingRecipient>[] | 'throws' } = {},
): ReadsFixture {
  const store = makeFakeApprovalStore(seed);
  const reads: EblastNotificationReads = {
    broadcastsRepo: store.broadcastsRepo,
    versionsRepo: store.versionsRepo,
    decisionsRepo: store.decisionsRepo,
    portalRecipients: makeFakePortalRecipients({ [MEMBER_ID]: opts.contacts ?? [makePortalContact({ email: 'owner-now@acme.test', locale: 'sv' })] }),
    companyName: vi.fn(async () => (opts.company === undefined ? COMPANY : opts.company)),
    marketingRoster: vi.fn(async () => {
      if (opts.roster === 'throws') throw new Error('users read failed');
      return opts.roster ?? [makeMarketingRecipient()];
    }),
  };
  return { store, reads };
}

const row = (notificationType: string, contextData: Record<string, unknown>, extra: Partial<EblastOutboxRow> = {}): EblastOutboxRow => ({
  id: 'outbox-row-1',
  notificationType,
  tenantId: TENANT,
  toEmail: 'frozen-at-enqueue@acme.test',
  locale: 'en',
  contextData: { tenantId: TENANT, broadcastId: BROADCAST_ID, ...contextData },
  ...extra,
});

/** A broadcast carrying every value a staff email must never show. */
const loaded = (overrides: Partial<Broadcast> = {}) =>
  makeApprovalBroadcast({
    bodyHtml: BODY,
    proposedSendAt: PROPOSED,
    scheduledFor: CONFIRMED,
    currentRound: 1,
    ...overrides,
  });
const sentV1 = makeApprovalVersion({ id: V1, noteToMember: NOTE, bodyHtml: BODY, sentToMemberAt: SENT_AT, subject: 'Formatted subject' });
const decision = (overrides: Partial<MemberDecision> = {}): MemberDecision => ({
  id: 'dec-1',
  tenantId: TENANT,
  broadcastId: makeApprovalBroadcast().broadcastId,
  versionId: V1,
  round: 1,
  decision: 'changes_requested',
  reason: REASON,
  decidedByUserId: '33333333-3333-4333-8333-333333333333',
  decidedByContactId: 'dddddddd-0000-4000-8000-000000000001',
  decidedAt: SENT_AT,
  ...overrides,
});

type Rendered = { subject: string; html: string; text: string; toEmail?: string };
const rendered = (v: unknown): Rendered => {
  expect(v).not.toBeNull();
  expect(v).not.toHaveProperty('miss');
  return v as Rendered;
};

function staffLeaks(email: Rendered): string[] {
  const all = `${email.subject}\n${email.html}\n${email.text}`;
  const forbidden = [
    'SECRET-BODY-7f3a',
    'SECRET-REASON-91c2',
    'SECRET-NOTE-44de',
    PROPOSED.toISOString(),
    CONFIRMED.toISOString(),
    ...(['en', 'th', 'sv'] as const).flatMap((l) => [formatEblastEmailDate(PROPOSED, l), formatEblastEmailDate(CONFIRMED, l), formatEblastEmailDate(SENT_AT, l)]),
  ];
  return forbidden.filter((f) => all.includes(f) || all.includes(escapeHtml(f)));
}

describe('eblast_member_decided_marketing — FR-021b staff containment', () => {
  it.each(['approved', 'changes_requested', 'approval_withdrawn', 'withdrawn'] as const)(
    'decision %s: subject + company + stage + link, and none of the body, reason, note or times',
    async (d) => {
      const { reads } = fixture({ broadcasts: [loaded({ status: d === 'approved' ? 'member_approved' : 'changes_requested' })], versions: [sentV1], decisions: [decision({ decision: d === 'withdrawn' ? 'approval_withdrawn' : d })] });
      const email = rendered(await buildEblastNotificationPayload(row('eblast_member_decided_marketing', { versionId: V1, round: 1, decision: d, recipientUserId: MARKETER_ID }), () => reads));
      expect(staffLeaks(email)).toEqual([]);
      expect(email.text).toContain('Member original subject');
      expect(email.text).toContain(COMPANY);
      expect(email.text).toContain(`/admin/broadcasts/${BROADCAST_ID}`);
      expect(email.toEmail).toBe('marketing@swecham.test');
    },
  );

  it('positive control: the leak matcher fails when the member\'s reason is spliced back in', async () => {
    const { reads } = fixture({ broadcasts: [loaded()], decisions: [decision()] });
    const email = rendered(await buildEblastNotificationPayload(row('eblast_member_decided_marketing', { versionId: V1, round: 1, decision: 'changes_requested', recipientUserId: MARKETER_ID }), () => reads));
    expect(staffLeaks({ ...email, html: `${email.html}<p>${escapeHtml(REASON)}</p>` })).toEqual(['SECRET-REASON-91c2']);
  });

  it('versionId: null and round: null (a withdrawal from submitted) renders a complete email and does not throw', async () => {
    const { reads } = fixture({ broadcasts: [loaded({ status: 'cancelled', currentRound: 0 })] });
    const out = await buildEblastNotificationPayload(row('eblast_member_decided_marketing', { versionId: null, round: null, decision: 'withdrawn', recipientUserId: MARKETER_ID }), () => reads);
    const email = rendered(out);
    expect(email.subject).toContain('Member original subject');
    expect(email.text).toContain(COMPANY);
    expect(email.text).toContain('Withdrawn');
    expect(email.text).toContain(`/admin/broadcasts/${BROADCAST_ID}`);
    expect(email.html).not.toMatch(/undefined|null|\{\w+\}/);
  });

  it('the recipient is re-checked against the LIVE roster: by user id when the row carries one, else by the frozen address', async () => {
    const roster = [makeMarketingRecipient({ userId: 'u-1', email: 'moved@swecham.test' })];
    const byId = fixture({ broadcasts: [loaded()] }, { roster });
    const out = await buildEblastNotificationPayload(row('eblast_member_decided_marketing', { versionId: V1, round: 1, decision: 'approved', recipientUserId: 'u-1' }), () => byId.reads);
    expect(rendered(out).toEmail).toBe('moved@swecham.test');

    const gone = fixture({ broadcasts: [loaded()] }, { roster: [] });
    expect(await buildEblastNotificationPayload(row('eblast_member_decided_marketing', { versionId: V1, round: 1, decision: 'approved' }), () => gone.reads)).toEqual({ miss: 'recipient_gone' });
  });

  it('a broadcast or member gone → request_gone; a transient roster fault → null (the retry ladder), never a throw', async () => {
    const ctx = { versionId: V1, round: 1, decision: 'approved', recipientUserId: MARKETER_ID };
    expect(await buildEblastNotificationPayload(row('eblast_member_decided_marketing', ctx), () => fixture({}).reads)).toEqual({ miss: 'request_gone' });
    expect(await buildEblastNotificationPayload(row('eblast_member_decided_marketing', ctx), () => fixture({ broadcasts: [loaded()] }, { company: null }).reads)).toEqual({ miss: 'request_gone' });
    await expect(buildEblastNotificationPayload(row('eblast_member_decided_marketing', ctx), () => fixture({ broadcasts: [loaded()] }, { roster: 'throws' }).reads)).resolves.toBeNull();
  });

  describe('stale rows are superseded — held while the flag was off, drained on the re-flip', () => {
    const V2 = 'aaaaaaaa-0000-4000-8000-000000000002';
    const LATER = new Date(SENT_AT.getTime() + 86_400_000);
    const decided = (d: string, round: number | null = 1, versionId: string | null = V1) =>
      row('eblast_member_decided_marketing', { versionId, round, decision: d, recipientUserId: MARKETER_ID });
    const run = (f: ReadsFixture, r: EblastOutboxRow) => buildEblastNotificationPayload(r, () => f.reads);

    it('a decision in a LATER round → request_superseded', async () => {
      const f = fixture({
        broadcasts: [loaded({ status: 'member_approved', currentRound: 2 })],
        decisions: [decision({ decision: 'changes_requested' }), decision({ id: 'dec-2', versionId: V2, round: 2, decision: 'approved', decidedAt: LATER })],
      });
      expect(await run(f, decided('changes_requested'))).toEqual({ miss: 'request_superseded' });
      // …and the newer one still renders.
      rendered(await run(f, decided('approved', 2, V2)));
    });

    it('a LATER decision in the same round (approved, then the approval withdrawn) → the approval row is superseded, the withdrawal renders', async () => {
      const f = fixture({
        broadcasts: [loaded({ status: 'changes_requested', currentRound: 1 })],
        decisions: [decision({ decision: 'approved' }), decision({ id: 'dec-2', decision: 'approval_withdrawn', decidedAt: LATER })],
      });
      expect(await run(f, decided('approved'))).toEqual({ miss: 'request_superseded' });
      rendered(await run(f, decided('approval_withdrawn')));
    });

    it.each(['sent', 'rejected', 'cancelled', 'failed_to_dispatch', 'expired_no_member_response'] as const)(
      'the E-Blast reached terminal %s → request_superseded',
      async (status) => {
        const f = fixture({ broadcasts: [loaded({ status })], decisions: [decision({ decision: 'approved' })] });
        expect(await run(f, decided('approved'))).toEqual({ miss: 'request_superseded' });
      },
    );

    it('a still-current decision on a live row renders (the rule is not over-eager)', async () => {
      for (const status of ['member_approved', 'approved', 'sending'] as const) {
        const f = fixture({ broadcasts: [loaded({ status })], decisions: [decision({ decision: 'approved' })] });
        rendered(await run(f, decided('approved')));
      }
    });

    it('a member withdrawal IS the terminal event: it renders on the cancelled row even after earlier decisions', async () => {
      const f = fixture({ broadcasts: [loaded({ status: 'cancelled' })], decisions: [decision({ decision: 'approved' })] });
      expect(rendered(await run(f, decided('withdrawn'))).text).toContain('Withdrawn');
    });

    it('a decision row without its round is malformed (null — the retry ladder), never a throw', async () => {
      const f = fixture({ broadcasts: [loaded({ status: 'member_approved' })], decisions: [decision({ decision: 'approved' })] });
      await expect(run(f, decided('approved', null))).resolves.toBeNull();
    });
  });
});

describe('eblast_submitted_marketing — FR-021b staff containment (T129)', () => {
  const submitted = () => loaded({ status: 'submitted', currentRound: 0, scheduledFor: PROPOSED });

  it('subject + company + "Awaiting marketing review" + link, to the roster member at their CURRENT address, and none of the body or the proposed time', async () => {
    const roster = [makeMarketingRecipient({ userId: 'u-1', email: 'moved@swecham.test' })];
    const { reads } = fixture({ broadcasts: [submitted()] }, { roster });
    const email = rendered(await buildEblastNotificationPayload(row('eblast_submitted_marketing', { recipientUserId: 'u-1' }), () => reads));
    expect(staffLeaks(email)).toEqual([]);
    expect(email.subject).toContain('Member original subject');
    expect(email.text).toContain(COMPANY);
    expect(email.text).toContain('Awaiting marketing review');
    expect(email.text).toContain(`/admin/broadcasts/${BROADCAST_ID}`);
    expect(email.toEmail).toBe('moved@swecham.test');
  });

  it('marketing already acted (approved, formatting, rejected, cancelled) → request_superseded, never a stale "to review"', async () => {
    for (const status of ['approved', 'in_design', 'rejected', 'cancelled'] as const) {
      const { reads } = fixture({ broadcasts: [loaded({ status })] });
      expect(await buildEblastNotificationPayload(row('eblast_submitted_marketing', { recipientUserId: MARKETER_ID }), () => reads)).toEqual({ miss: 'request_superseded' });
    }
  });

  it('misses: broadcast or member gone → request_gone; a recipient off the roster → recipient_gone; a roster fault → null', async () => {
    const run = (f: ReadsFixture, ctx: Record<string, unknown> = { recipientUserId: MARKETER_ID }) =>
      buildEblastNotificationPayload(row('eblast_submitted_marketing', ctx), () => f.reads);
    expect(await run(fixture({}))).toEqual({ miss: 'request_gone' });
    expect(await run(fixture({ broadcasts: [submitted()] }, { company: null }))).toEqual({ miss: 'request_gone' });
    expect(await run(fixture({ broadcasts: [submitted()] }, { roster: [] }))).toEqual({ miss: 'recipient_gone' });
    expect(await run(fixture({ broadcasts: [submitted()] }, { roster: 'throws' }))).toBeNull();
  });
});

describe('eblast_approval_lifecycle — both audiences (T131)', () => {
  const awaiting = (overrides: Partial<Broadcast> = {}) =>
    loaded({ status: 'awaiting_member_approval', currentRound: 1, stageEnteredAt: SENT_AT, ...overrides });
  const lifecycle = (kind: string, audience: string, extra: Record<string, unknown> = {}) =>
    row('eblast_approval_lifecycle', { versionId: V1, round: 1, kind, audience, ...extra });
  const dayOf = (day: number, locale: 'en' | 'th' | 'sv') =>
    formatEblastEmailDate(new Date(SENT_AT.getTime() + day * 86_400_000), locale);

  it.each([
    ['expiry_warning_day23', 'awaiting_member_approval', 'Awaiting member approval'],
    ['expired_day30', 'expired_no_member_response', 'Expired'],
  ] as const)('staff %s: subject + company + stage + link, and none of the body, note or times', async (kind, status, stage) => {
    const { reads } = fixture({ broadcasts: [awaiting({ status })], versions: [sentV1] });
    const email = rendered(await buildEblastNotificationPayload(lifecycle(kind, 'staff', { recipientUserId: MARKETER_ID }), () => reads));
    expect(staffLeaks(email)).toEqual([]);
    expect(email.subject).toContain('Member original subject');
    expect(email.text).toContain(COMPANY);
    expect(email.text).toContain(stage);
    expect(email.text).toContain(`/admin/broadcasts/${BROADCAST_ID}`);
    expect(email.toEmail).toBe('marketing@swecham.test');
  });

  it('positive control: the staff leak matcher fails when the note is spliced into a lifecycle email', async () => {
    const { reads } = fixture({ broadcasts: [awaiting()], versions: [sentV1] });
    const email = rendered(await buildEblastNotificationPayload(lifecycle('expiry_warning_day23', 'staff', { recipientUserId: MARKETER_ID }), () => reads));
    expect(staffLeaks({ ...email, text: `${email.text}\n${NOTE}` })).toEqual(['SECRET-NOTE-44de']);
  });

  it('member day-3 reminder: to the approval contact NOW, in their language, restating the REMAINING timeline (7 / 23 / 30, not 3)', async () => {
    const { reads } = fixture({ broadcasts: [awaiting()], versions: [sentV1] });
    const email = rendered(await buildEblastNotificationPayload(lifecycle('reminder_day3', 'member'), () => reads));
    expect(email.toEmail).toBe('owner-now@acme.test');
    expect(email.html).toContain('lang="sv"');
    expect(email.text).toContain('Formatted subject');
    for (const day of [7, 23, 30]) expect(email.text).toContain(dayOf(day, 'sv'));
    expect(email.text).not.toContain(dayOf(3, 'sv'));
    expect(email.text).toContain(`/portal/broadcasts/${BROADCAST_ID}`);
  });

  it('member day-23 warning restates day 30 only; the day-30 closure restates nothing and links to the list', async () => {
    const warn = fixture({ broadcasts: [awaiting()], versions: [sentV1] });
    const warning = rendered(await buildEblastNotificationPayload(lifecycle('expiry_warning_day23', 'member'), () => warn.reads));
    expect(warning.text).toContain(dayOf(30, 'sv'));
    for (const day of [3, 7, 23]) expect(warning.text).not.toContain(dayOf(day, 'sv'));

    const closed = fixture({ broadcasts: [awaiting({ status: 'expired_no_member_response' })], versions: [sentV1] });
    const closure = rendered(await buildEblastNotificationPayload(lifecycle('expired_day30', 'member'), () => closed.reads));
    for (const day of [3, 7, 23]) expect(closure.text).not.toContain(dayOf(day, 'sv'));
    expect(closure.text).toMatch(/\/portal\/broadcasts$/m);
  });

  it('stale rows are superseded: the member decided, a later round was sent, or a closure the row never reached', async () => {
    const run = (b: Broadcast, kind: string, audience = 'member') =>
      buildEblastNotificationPayload(lifecycle(kind, audience, { recipientUserId: MARKETER_ID }), () => fixture({ broadcasts: [b], versions: [sentV1] }).reads);
    expect(await run(awaiting({ status: 'member_approved' }), 'reminder_day7')).toEqual({ miss: 'request_superseded' });
    expect(await run(awaiting({ currentRound: 2 }), 'reminder_day3')).toEqual({ miss: 'request_superseded' });
    expect(await run(awaiting({ status: 'changes_requested' }), 'expiry_warning_day23', 'staff')).toEqual({ miss: 'request_superseded' });
    expect(await run(awaiting(), 'expired_day30')).toEqual({ miss: 'request_superseded' });
  });

  it('misses and malformed rows: gone → request_gone; nobody to send to → recipient_gone; an unknown kind or audience → null, never a throw', async () => {
    const good = () => fixture({ broadcasts: [awaiting()], versions: [sentV1] });
    const run = (f: ReadsFixture, r: EblastOutboxRow) => buildEblastNotificationPayload(r, () => f.reads);
    const staffRow = lifecycle('expiry_warning_day23', 'staff', { recipientUserId: MARKETER_ID });
    expect(await run(fixture({}), lifecycle('reminder_day3', 'member'))).toEqual({ miss: 'request_gone' });
    expect(await run(fixture({ broadcasts: [awaiting()] }), lifecycle('reminder_day3', 'member'))).toEqual({ miss: 'request_gone' });
    expect(await run(fixture({ broadcasts: [awaiting()], versions: [sentV1] }, { contacts: [] }), lifecycle('reminder_day3', 'member'))).toEqual({ miss: 'recipient_gone' });
    expect(await run(fixture({ broadcasts: [awaiting()], versions: [sentV1] }, { roster: [] }), staffRow)).toEqual({ miss: 'recipient_gone' });
    expect(await run(fixture({ broadcasts: [awaiting()], versions: [sentV1] }, { company: null }), staffRow)).toEqual({ miss: 'request_gone' });
    await expect(run(good(), lifecycle('reminder_day99', 'member'))).resolves.toBeNull();
    await expect(run(good(), lifecycle('reminder_day3', 'robot'))).resolves.toBeNull();
    await expect(run(good(), row('eblast_approval_lifecycle', { versionId: V1, kind: 'reminder_day3', audience: 'member' }))).resolves.toBeNull();
  });
});

describe('eblast_version_sent_member — the full timeline at the moment the clock starts (T131, FR-021b)', () => {
  it('the member "version ready" rendering states day 3, day 7, day 23 and day 30 — each with its own date, in every locale', async () => {
    for (const locale of ['en', 'th', 'sv'] as const) {
      const { reads } = fixture(
        { broadcasts: [loaded({ status: 'awaiting_member_approval', currentRound: 1 })], versions: [sentV1] },
        { contacts: [makePortalContact({ locale })] },
      );
      const email = rendered(await buildEblastNotificationPayload(row('eblast_version_sent_member', { versionId: V1, round: 1 }), () => reads));
      for (const day of [3, 7, 23, 30]) {
        expect(email.text, `${locale} day ${day}`).toContain(formatEblastEmailDate(new Date(SENT_AT.getTime() + day * 86_400_000), locale));
      }
      if (locale === 'en') {
        for (const label of ['Day 3 (', 'Day 7 (', 'Day 23 (', 'Day 30 (']) expect(email.text).toContain(label);
      }
    }
  });
});

describe('eblast_version_sent_member — rendered from the rows at send time', () => {
  const ready = () => loaded({ status: 'awaiting_member_approval', currentRound: 1 });

  it('goes to the approval contact\'s CURRENT address in their language, with the note, the proposal and the day 3/7/23/30 timeline', async () => {
    const { reads } = fixture({ broadcasts: [ready()], versions: [sentV1] });
    const email = rendered(await buildEblastNotificationPayload(row('eblast_version_sent_member', { versionId: V1, round: 1 }), () => reads));
    expect(email.toEmail).toBe('owner-now@acme.test');
    expect(email.html).toContain('lang="sv"');
    expect(email.text).toContain('Formatted subject');
    expect(email.text).toContain(NOTE);
    expect(email.text).toContain(formatEblastEmailDate(PROPOSED, 'sv'));
    for (const day of [3, 7, 23, 30]) expect(email.text).toContain(formatEblastEmailDate(new Date(SENT_AT.getTime() + day * 86_400_000), 'sv'));
    expect(email.text).toContain(`/portal/broadcasts/${BROADCAST_ID}`);
  });

  it('misses: broadcast or version gone → request_gone; a later round or a decided row → request_superseded; nobody can sign in → recipient_gone', async () => {
    const ctx = { versionId: V1, round: 1 };
    const run = (f: ReadsFixture, c: Record<string, unknown> = ctx) => buildEblastNotificationPayload(row('eblast_version_sent_member', c), () => f.reads);
    expect(await run(fixture({}))).toEqual({ miss: 'request_gone' });
    expect(await run(fixture({ broadcasts: [ready()] }))).toEqual({ miss: 'request_gone' });
    expect(await run(fixture({ broadcasts: [loaded({ status: 'awaiting_member_approval', currentRound: 2 })], versions: [sentV1] }))).toEqual({ miss: 'request_superseded' });
    expect(await run(fixture({ broadcasts: [loaded({ status: 'member_approved', currentRound: 1 })], versions: [sentV1] }))).toEqual({ miss: 'request_superseded' });
    expect(await run(fixture({ broadcasts: [ready()], versions: [sentV1] }, { contacts: [] }))).toEqual({ miss: 'recipient_gone' });
  });

  it('context_data without the ids it needs is not rendered (null — the F114 malformed-row parity), and never throws', async () => {
    const { reads } = fixture({ broadcasts: [ready()], versions: [sentV1] });
    await expect(buildEblastNotificationPayload(row('eblast_version_sent_member', { versionId: V1 }), () => reads)).resolves.toBeNull();
    await expect(buildEblastNotificationPayload(row('eblast_version_sent_member', { versionId: V1, round: 1 }, { tenantId: 'BAD TENANT' }), () => reads)).resolves.toBeNull();
  });
});

describe('eblast_schedule_confirmed_member — both times when they differ', () => {
  const scheduled = (overrides: Partial<Broadcast> = {}) => loaded({ status: 'approved', approvedVersionId: V1, ...overrides });

  it('the confirmed time, the proposal beside it and the "not the time you proposed" line when they differ', async () => {
    const { reads } = fixture({ broadcasts: [scheduled()] }, { contacts: [makePortalContact({ email: 'owner-now@acme.test', locale: 'en' })] });
    const email = rendered(await buildEblastNotificationPayload(row('eblast_schedule_confirmed_member', { versionId: V1 }), () => reads));
    expect(email.text).toContain(formatEblastEmailDate(CONFIRMED, 'en'));
    expect(email.text).toContain(formatEblastEmailDate(PROPOSED, 'en'));
    expect(email.text).toContain('This is not the time you proposed.');
    expect(email.toEmail).toBe('owner-now@acme.test');
  });

  it('only the confirmed time when they match', async () => {
    const { reads } = fixture({ broadcasts: [scheduled({ scheduledFor: PROPOSED })] }, { contacts: [makePortalContact({ locale: 'en' })] });
    const email = rendered(await buildEblastNotificationPayload(row('eblast_schedule_confirmed_member', { versionId: V1 }), () => reads));
    expect(email.text).not.toContain('This is not the time you proposed.');
  });

  it('a send time cancelled, or an approval replaced, before the row was sent → request_superseded', async () => {
    const run = (b: Broadcast) => buildEblastNotificationPayload(row('eblast_schedule_confirmed_member', { versionId: V1 }), () => fixture({ broadcasts: [b] }).reads);
    expect(await run(scheduled({ status: 'changes_requested', scheduledFor: null, approvedVersionId: null }))).toEqual({ miss: 'request_superseded' });
    expect(await run(scheduled({ approvedVersionId: 'aaaaaaaa-0000-4000-8000-000000000009' }))).toEqual({ miss: 'request_superseded' });
  });
});

// ---------------------------------------------------------------------------
// 4. SC-004 — the enqueue shares the state-changing transaction
// ---------------------------------------------------------------------------

const ID_ONLY_KEYS = new Set(['tenantId', 'broadcastId', 'versionId', 'round', 'decision', 'kind', 'audience', 'recipientUserId']);

describe('SC-004 — every hand-off enqueues its outbox row inside the state-changing transaction', () => {
  let store: FakeApprovalStore;
  const tenant = asTenantContext(TENANT);
  const common = () => ({
    tenant,
    broadcastsRepo: store.broadcastsRepo,
    versionsRepo: store.versionsRepo,
    imageAllowlist: makeFakeImageAllowlist(),
    portalRecipients: makeFakePortalRecipients({ [MEMBER_ID]: [makePortalContact()] }),
    outbox: store.outbox,
    audit: makeRecordingF7Audit(),
    clock: { now: () => store.now },
  });
  const actor = { actorUserId: '44444444-4444-4444-8444-444444444444', actorRole: 'marketing', requestId: 'req-sc004' };

  const send = () =>
    sendVersionToMember({ ...common(), sanitizer: dompurifySanitizer }, { broadcastId: makeApprovalBroadcast().broadcastId, ...actor });
  const schedule = () =>
    confirmSchedule(common(), { broadcastId: makeApprovalBroadcast().broadcastId, ...actor, mode: { mode: 'keep_proposal' } });

  const cases = [
    {
      name: 'send a version to the member (T059)',
      seed: () =>
        makeFakeApprovalStore({
          broadcasts: [makeApprovalBroadcast({ status: 'in_design', currentRound: 0 })],
          versions: [makeApprovalVersion({ versionNo: 0, id: 'aaaaaaaa-0000-4000-8000-000000000000', sentToMemberAt: SENT_AT }), makeApprovalVersion()],
        }),
      act: send,
      type: 'eblast_version_sent_member',
    },
    {
      name: 'confirm the send time (T060)',
      seed: () =>
        makeFakeApprovalStore({
          broadcasts: [makeApprovalBroadcast({ status: 'member_approved', currentRound: 1, approvedVersionId: V1, proposedSendAt: new Date('2026-10-01T03:00:00.000Z') })],
          versions: [makeApprovalVersion({ sentToMemberAt: SENT_AT })],
        }),
      act: schedule,
      type: 'eblast_schedule_confirmed_member',
    },
  ] as const;

  beforeEach(() => {
    store = makeFakeApprovalStore();
  });

  it.each(cases)('$name: commit → exactly one row per recipient, on the tx withTx handed out, ids only', async ({ seed, act, type }) => {
    store = seed();
    const result = await act();
    expect(result.ok).toBe(true);
    const rows = store.outbox.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe(type);
    expect(rows[0]!.tx).toBe(FAKE_TX);
    expect(Object.keys(rows[0]!.contextData).filter((k) => !ID_ONLY_KEYS.has(k))).toEqual([]);
  });

  it.each(cases)('$name: a commit failure AFTER the enqueue → zero rows, nothing else written', async ({ seed, act }) => {
    store = seed();
    const before = new Map(store.state.broadcasts);
    store.failNextCommit();
    const result = await act();
    expect(result.ok).toBe(false);
    expect(store.outbox.enqueueInTx).toHaveBeenCalledTimes(1); // the enqueue DID run inside the tx…
    expect(store.outbox.rows()).toHaveLength(0); // …and rolled back with it
    expect(store.state.broadcasts).toEqual(before);
  });

  describe('record a member decision (T078) — one eblast_member_decided_marketing row PER marketing recipient', () => {
    const roster = [makeMarketingRecipient(), makeMarketingRecipient({ userId: '88888888-8888-4888-8888-888888888888', email: 'marketing-2@swecham.test' })];
    const seedAwaiting = () =>
      makeFakeApprovalStore({
        broadcasts: [makeApprovalBroadcast({ status: 'awaiting_member_approval', currentRound: 1 })],
        versions: [makeApprovalVersion({ sentToMemberAt: SENT_AT })],
      });
    const decide = () =>
      recordMemberDecision(
        {
          tenant,
          broadcastsRepo: store.broadcastsRepo,
          versionsRepo: store.versionsRepo,
          decisionsRepo: store.decisionsRepo,
          marketingDirectory: makeFakeMarketingDirectory(roster),
          outbox: store.outbox,
          audit: makeRecordingF7Audit(),
          clock: { now: () => store.now },
        },
        {
          broadcastId: makeApprovalBroadcast().broadcastId,
          memberId: MEMBER_ID,
          actorUserId: '33333333-3333-4333-8333-333333333333',
          actorRole: 'member',
          contactId: 'dddddddd-0000-4000-8000-000000000001',
          versionId: V1,
          decision: 'changes_requested',
          reason: REASON,
          requestId: 'req-sc004-decide',
        },
      );

    it('commit → exactly one row per recipient, on the tx withTx handed out, ids only (the reason is not among them)', async () => {
      store = seedAwaiting();
      const result = await decide();
      expect(result.ok).toBe(true);
      const rows = store.outbox.rows();
      expect(rows.map((r) => r.toEmail)).toEqual(roster.map((r) => r.email));
      for (const r of rows) {
        expect(r.type).toBe('eblast_member_decided_marketing');
        expect(r.tx).toBe(FAKE_TX);
        expect(Object.keys(r.contextData).filter((k) => !ID_ONLY_KEYS.has(k))).toEqual([]);
      }
      expect(JSON.stringify(rows)).not.toContain('SECRET-REASON');
    });

    it('a commit failure AFTER the enqueue → zero rows, no decision row, the stage unchanged', async () => {
      store = seedAwaiting();
      const before = new Map(store.state.broadcasts);
      store.failNextCommit();
      const result = await decide();
      expect(result.ok).toBe(false);
      expect(store.outbox.enqueueInTx).toHaveBeenCalledTimes(roster.length); // the enqueues DID run inside the tx…
      expect(store.outbox.rows()).toHaveLength(0); // …and rolled back with it
      expect(store.decisionsRepo.rows()).toHaveLength(0);
      expect(store.state.broadcasts).toEqual(before);
    });
  });
});
