/**
 * F119 T065 — the approval-round outbox arms, rendered AT SEND TIME
 * (contracts/dashboard-and-notifications.md § 3, research R14, FR-021b,
 * FR-024). The dispatcher's `buildPayload` (`src/app/api/cron/outbox-dispatch/
 * route.ts`) delegates its `eblast_*` `case` labels here.
 *
 * `context_data` carries ids and discriminators only; the rows are read now,
 * under the row's tenant (`BroadcastsRepo.withTx` = `runInTenant`), so the
 * erasure scrub of a version or a decision blanks anything a not-yet-sent
 * email would show, and a sent outbox row holds no content at all. The F114
 * arms are the precedent; the difference is that these live in one module with
 * injectable reads (`EblastNotificationReads`), so the contract test runs them
 * over the in-memory approval store instead of live Postgres.
 *
 * Outcomes, as the dispatcher reads them:
 *   - a payload (with `toEmail`: the recipient re-resolved NOW);
 *   - `{ miss }` — deterministic, permanent on the first tick:
 *       `request_gone`       the broadcast, the version or the member is gone;
 *       `recipient_gone`     nobody to send to any more (no active portal
 *                            contact; the staff user left the roster);
 *       `request_superseded` the hand-off is stale — a later round, a
 *                            decided or cancelled row (the silent path);
 *   - `{ transient: 'read_failed' }` — a read threw: the retry ladder, and after
 *     `MAX_ATTEMPTS` the row closes as `read_failed` (#400 item 4 — it used to
 *     close as `no_template_handler`, although the template exists);
 *   - `null` — malformed `context_data`: the retry ladder, logged here first
 *     (`malformed_context`), closing as `no_template_handler`.
 *
 * Never throws — an arm that throws escapes `dispatchOne` without bumping
 * `attempts`. Never logs an address, a subject, a body, a note or a reason.
 */
import type { Locale } from '@/i18n/config';
import { logger } from '@/lib/logger';
import { READ_FAILED, type PayloadMiss, type PayloadTransient } from '@/lib/outbox-unbuilt-payload';
import { memberPortalRecipients } from '@/lib/broadcast-approval-deps';
import { resolveMarketingRoster } from '@/lib/broadcast-marketing-deps';
import {
  ApprovalDependencyError,
  EBLAST_LIFECYCLE_KINDS,
  EBLAST_MEMBER_DECIDED_KINDS,
  approvalErrKind,
  buildEblastApprovalLifecycleEmail,
  buildEblastMemberDecidedMarketingEmail,
  buildEblastScheduleConfirmedMemberEmail,
  buildEblastSubmittedMarketingEmail,
  buildEblastVersionSentMemberEmail,
  chooseApprovalRecipient,
  drizzleBroadcastVersionsRepo,
  makeDrizzleBroadcastsRepo,
  parseBroadcastId,
  type ApprovalBroadcastsRepo,
  drizzleBroadcastDecisionsRepo,
  hasSendingStarted,
  isTerminalStatus,
  type BroadcastDecisionsRepo,
  type BroadcastId,
  type BroadcastVersionsRepo,
  type Broadcast,
  type BuiltEblastEmail,
  type EblastLifecycleKind,
  type EblastMemberDecidedKind,
  type EblastNotificationContexts,
  type F119NotificationType,
  type MarketingRecipient,
  type MemberPortalRecipientPort,
} from '@/modules/broadcasts';
// A runtime members-barrel import is safe HERE (composition layer, imported by
// neither barrel); an approval use case re-brands with `ownerMemberId` instead
// (`_owner-member-id.ts` explains the cycle).
import { asMemberId, drizzleMemberRepo } from '@/modules/members';
import { asTenantContext, type TenantContext } from '@/modules/tenants';

/** The outbox row fields an arm reads (structural — no Drizzle type here). */
export interface EblastOutboxRow {
  readonly id: string;
  readonly notificationType: string;
  readonly tenantId: string | null;
  readonly toEmail: string;
  readonly locale: string | null;
  readonly contextData: unknown;
}

/**
 * The dispatcher's miss vocabulary (`PayloadMiss`), so the two unions cannot
 * drift (#400 item 4). These arms never answer `request_not_decided` (an F114
 * member-arm reason); it is in the type because the dispatcher's is.
 */
export type EblastPayloadMiss = PayloadMiss;
export type EblastPayload = (BuiltEblastEmail & { readonly toEmail: string }) | EblastPayloadMiss | PayloadTransient | null;

/** Everything an arm reads. Each method THROWS on a transient fault. */
export interface EblastNotificationReads {
  readonly broadcastsRepo: Pick<ApprovalBroadcastsRepo, 'withTx' | 'findByIdInTx'>;
  readonly versionsRepo: Pick<BroadcastVersionsRepo, 'listByBroadcast'>;
  /** The member's decisions, oldest first — the staleness test of a decided hand-off. */
  readonly decisionsRepo: Pick<BroadcastDecisionsRepo, 'listByBroadcast'>;
  readonly portalRecipients: MemberPortalRecipientPort;
  /** The member company's name; `null` ⇒ the member row is gone. */
  readonly companyName: (memberId: string) => Promise<string | null>;
  /** The live hand-off roster (no counter — the enqueue counted an empty one). */
  readonly marketingRoster: () => Promise<readonly MarketingRecipient[]>;
}

/** Production reads for one tenant. */
export function makeEblastNotificationReads(tenantId: string): EblastNotificationReads {
  const tenant = asTenantContext(tenantId);
  return {
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenantId),
    versionsRepo: drizzleBroadcastVersionsRepo,
    decisionsRepo: drizzleBroadcastDecisionsRepo,
    portalRecipients: memberPortalRecipients,
    async companyName(memberId) {
      const member = await drizzleMemberRepo.findById(tenant, asMemberId(memberId));
      if (member.ok) return member.value.companyName;
      if (member.error.code === 'repo.not_found') return null;
      throw new ApprovalDependencyError('member_company', member.error.code);
    },
    marketingRoster: resolveMarketingRoster,
  };
}

/** The tenant-slug shape guard every tenant-scoped arm applies (F114, S9). */
const TENANT_SLUG = /^[a-z0-9-]{1,63}$/;

/**
 * #400 item 3 — a STORED row's `context_data`, per type: exactly the keys its
 * producer writes (`EblastNotificationContexts`, the port's union), each still
 * `unknown`. A DB row is untyped, so every value is re-checked below and a bad
 * one is `malformed()`; typing the KEYS is what ties each arm to its producer —
 * a key renamed or dropped at the port fails to compile here instead of
 * silently dropping the email at send time.
 */
type KeysOf<T> = T extends unknown ? keyof T : never;
type StoredContext<T extends F119NotificationType> = {
  readonly [K in KeysOf<EblastNotificationContexts[T]>]?: unknown;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const isLocale = (v: unknown): v is Locale => v === 'en' || v === 'th' || v === 'sv';
const isDecidedKind = (v: unknown): v is EblastMemberDecidedKind =>
  (EBLAST_MEMBER_DECIDED_KINDS as readonly unknown[]).includes(v);
const isLifecycleKind = (v: unknown): v is EblastLifecycleKind =>
  (EBLAST_LIFECYCLE_KINDS as readonly unknown[]).includes(v);

/**
 * T166 R-M2 — how long a member's WITHDRAWAL (`decision: 'withdrawn'`, the
 * self-cancel) stays news to marketing. Every self-cancel enqueues one of these
 * rows unconditionally, including cancels from `submitted` (a live F7 path),
 * and with FEATURE_EBLAST_MEMBER_APPROVAL off they all wait in the outbox. On
 * the flip they would go out in one batch, weeks old. A withdrawal whose
 * `cancelled_at` is older than this is superseded instead (the silent
 * `request_superseded`); the E-Blast list still shows it as withdrawn.
 */
export const EBLAST_WITHDRAWN_NOTICE_MAX_AGE_DAYS = 7;
const WITHDRAWN_NOTICE_MAX_AGE_MS = EBLAST_WITHDRAWN_NOTICE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

const GONE: EblastPayloadMiss = { miss: 'request_gone' };
const RECIPIENT_GONE: EblastPayloadMiss = { miss: 'recipient_gone' };
const SUPERSEDED: EblastPayloadMiss = { miss: 'request_superseded' };
/** #400 item 4 — a read threw: the retry ladder, under its own reason (never `no_template_handler`). */

/**
 * Render one `eblast_*` outbox row. `readsFor` is injectable for the contract
 * test; production passes nothing.
 */
export async function buildEblastNotificationPayload(
  row: EblastOutboxRow,
  readsFor: (tenantId: string) => EblastNotificationReads = makeEblastNotificationReads,
): Promise<EblastPayload> {
  const ctx = (typeof row.contextData === 'object' && row.contextData !== null ? row.contextData : {}) as Readonly<Record<string, unknown>>;
  const parsed = parseBroadcastId(str(ctx.broadcastId) ?? '');
  if (!parsed.ok || row.tenantId === null || !TENANT_SLUG.test(row.tenantId)) return malformed(row, 'broadcast_or_tenant');
  const tenant = asTenantContext(row.tenantId);
  const broadcastId = parsed.value;
  const locale: Locale = isLocale(row.locale) ? row.locale : 'en';
  try {
    const reads = readsFor(row.tenantId);
    switch (row.notificationType) {
      case 'eblast_version_sent_member':
        return await versionSentMember(reads, tenant, broadcastId, ctx, row);
      case 'eblast_schedule_confirmed_member':
        return await scheduleConfirmedMember(reads, tenant, broadcastId, ctx, row);
      case 'eblast_member_decided_marketing':
        return await memberDecidedMarketing(reads, tenant, broadcastId, ctx, row, locale);
      case 'eblast_submitted_marketing':
        return await submittedMarketing(reads, tenant, broadcastId, ctx, row, locale);
      case 'eblast_approval_lifecycle':
        return await approvalLifecycle(reads, tenant, broadcastId, ctx, row, locale);
      default:
        return malformed(row, 'type');
    }
  } catch (e) {
    logger.warn(
      // Round-4 B3 — a failed dependency read keeps its cause here.
      { outboxRowId: row.id, tenantId: row.tenantId, notificationType: row.notificationType, err: approvalErrKind(e) },
      'M119.outbox_dispatch.eblast.read_failed',
    );
    return READ_FAILED;
  }
}

function malformed(row: EblastOutboxRow, field: string): null {
  logger.warn(
    { outboxRowId: row.id, tenantId: row.tenantId, notificationType: row.notificationType, field },
    'M119.outbox_dispatch.eblast.malformed_context',
  );
  return null;
}

/** Round N is ready — to the approval contact, in their language, while it is still that round. */
async function versionSentMember(
  reads: EblastNotificationReads,
  tenant: TenantContext,
  broadcastId: BroadcastId,
  ctx: StoredContext<'eblast_version_sent_member'>,
  row: EblastOutboxRow,
): Promise<EblastPayload> {
  const versionId = str(ctx.versionId);
  const round = int(ctx.round);
  if (versionId === null || round === null) return malformed(row, 'version_or_round');
  const read = await reads.broadcastsRepo.withTx(async (tx) => {
    const broadcast = await reads.broadcastsRepo.findByIdInTx(tx, tenant.slug, broadcastId);
    if (broadcast === null) return null;
    const versions = await reads.versionsRepo.listByBroadcast(tenant.slug, broadcastId, tx);
    const version = versions.find((v) => v.id === versionId);
    if (version === undefined) return null;
    const contacts = await reads.portalRecipients.listActivePortalContacts(tenant, asMemberId(broadcast.requestedByMemberId), tx);
    return { broadcast, version, recipient: chooseApprovalRecipient(contacts, broadcast.submittedByUserId) };
  });
  if (read === null) return GONE;
  const { broadcast, version, recipient } = read;
  // A later round was sent, or the member already decided / the row closed:
  // "round N is ready for your approval" would be wrong now.
  if (broadcast.status !== 'awaiting_member_approval' || broadcast.currentRound !== round || version.sentToMemberAt === null) {
    return SUPERSEDED;
  }
  if (recipient === null) return RECIPIENT_GONE;
  const email = buildEblastVersionSentMemberEmail({
    locale: recipient.locale,
    broadcastId,
    versionSubject: version.subject,
    round,
    noteToMember: version.noteToMember,
    proposedSendAt: broadcast.proposedSendAt,
    sentAt: version.sentToMemberAt,
  });
  return { ...email, toEmail: recipient.email };
}

/**
 * The send time is confirmed — to the approval contact. Stale when the time
 * was cancelled (`scheduled_for` cleared), the approval it confirmed no
 * longer governs the row, or the row CLOSED without sending (T166 R-M1: an
 * admin cancel, a rejection, a failed dispatch or the expiry leave both
 * columns set — trigger exemption E2 clears them on three targets only — so
 * the columns alone let "cancelled" and "your time is confirmed" both
 * arrive). A row that already went out, or is going out, still renders: a
 * "send now" can reach `sending` before this tick.
 */
async function scheduleConfirmedMember(
  reads: EblastNotificationReads,
  tenant: TenantContext,
  broadcastId: BroadcastId,
  ctx: StoredContext<'eblast_schedule_confirmed_member'>,
  row: EblastOutboxRow,
): Promise<EblastPayload> {
  const versionId = str(ctx.versionId);
  if (versionId === null) return malformed(row, 'version');
  const read = await reads.broadcastsRepo.withTx(async (tx) => {
    const broadcast = await reads.broadcastsRepo.findByIdInTx(tx, tenant.slug, broadcastId);
    if (broadcast === null) return null;
    const contacts = await reads.portalRecipients.listActivePortalContacts(tenant, asMemberId(broadcast.requestedByMemberId), tx);
    return { broadcast, recipient: chooseApprovalRecipient(contacts, broadcast.submittedByUserId) };
  });
  if (read === null) return GONE;
  const { broadcast, recipient } = read;
  if (broadcast.scheduledFor === null || broadcast.approvedVersionId !== versionId) return SUPERSEDED;
  if (isTerminalStatus(broadcast.status) && !hasSendingStarted(broadcast.status)) return SUPERSEDED;
  if (recipient === null) return RECIPIENT_GONE;
  const email = buildEblastScheduleConfirmedMemberEmail({
    locale: recipient.locale,
    broadcastId,
    broadcastSubject: broadcast.subject,
    proposedSendAt: broadcast.proposedSendAt,
    confirmedSendAt: broadcast.scheduledFor,
  });
  return { ...email, toEmail: recipient.email };
}

/**
 * The member decided (or withdrew) — to one marketing recipient: subject,
 * company, stage, link. Reads the broadcast ALONE: `versionId` is always null
 * on a whole-E-Blast withdrawal and `round` is null before the first round,
 * and nothing here needs them. The recipient must STILL be on the roster (F114: a user disabled
 * between enqueue and send gets nothing) — matched by user id when the row
 * carries it, else by the address frozen at enqueue — and is reached at the
 * CURRENT address.
 *
 * Stale — the silent `request_superseded`, like every other arm — when the
 * member has decided again since (a later round, or a later decision in the
 * same round: an approval then its withdrawal), or when the E-Blast has closed
 * (sent, rejected, cancelled, failed, expired). A member WITHDRAWAL is exempt
 * from that rule: it IS the closing event (the row is `cancelled` by it) and
 * nothing can follow it. It has its own staleness instead (T166 R-M2): older
 * than `EBLAST_WITHDRAWN_NOTICE_MAX_AGE_DAYS` since `cancelled_at`, it is
 * superseded. With the flag off these rows wait in the outbox and drain on the
 * re-flip, which is when both rules earn their keep.
 */
async function memberDecidedMarketing(
  reads: EblastNotificationReads,
  tenant: TenantContext,
  broadcastId: BroadcastId,
  ctx: StoredContext<'eblast_member_decided_marketing'>,
  row: EblastOutboxRow,
  locale: Locale,
): Promise<EblastPayload> {
  const decision = ctx.decision;
  if (!isDecidedKind(decision)) return malformed(row, 'decision');
  // The round the decision was recorded in; `undefined` for a withdrawal (no
  // staleness test). Every recorded decision carries one — a row without it
  // is malformed. (A withdrawal's own round may be null: from `submitted`.)
  const decidedIn = decision === 'withdrawn' ? undefined : int(ctx.round);
  if (decidedIn === null) return malformed(row, 'round');
  const read = await reads.broadcastsRepo.withTx(async (tx) => {
    const broadcast = await reads.broadcastsRepo.findByIdInTx(tx, tenant.slug, broadcastId);
    if (broadcast === null) return null;
    const decisions = decidedIn === undefined ? [] : await reads.decisionsRepo.listByBroadcast(tenant.slug, broadcastId, tx);
    return { broadcast, decisions };
  });
  if (read === null) return GONE;
  const { broadcast, decisions } = read;
  if (decidedIn !== undefined) {
    const lastInRound = decisions.filter((d) => d.round === decidedIn).at(-1);
    const decidedSince = decisions.some((d) => d.round > decidedIn) || (lastInRound !== undefined && lastInRound.decision !== decision);
    if (decidedSince || isTerminalStatus(broadcast.status)) return SUPERSEDED;
  } else if (broadcast.cancelledAt !== null && Date.now() - broadcast.cancelledAt.getTime() > WITHDRAWN_NOTICE_MAX_AGE_MS) {
    return SUPERSEDED;
  }
  return staffHandoff(reads, broadcast, ctx, row, (companyName) =>
    buildEblastMemberDecidedMarketingEmail({
      locale,
      broadcastId,
      broadcastSubject: broadcast.subject,
      companyName,
      decision,
    }),
  );
}

/**
 * The staff half every marketing-bound arm shares: the member company (gone →
 * `request_gone`), then the recipient re-checked against the LIVE roster
 * (F114: a user disabled between enqueue and send gets nothing) — by user id
 * when the row carries it, else by the address frozen at enqueue — and reached
 * at the CURRENT address. The builder sees the four FR-021b facts only.
 */
async function staffHandoff(
  reads: EblastNotificationReads,
  broadcast: Broadcast,
  ctx: Pick<StoredContext<'eblast_submitted_marketing'>, 'recipientUserId'>,
  row: EblastOutboxRow,
  build: (companyName: string) => BuiltEblastEmail,
): Promise<EblastPayload> {
  const companyName = await reads.companyName(broadcast.requestedByMemberId);
  if (companyName === null) return GONE;
  const roster = await reads.marketingRoster();
  const recipientUserId = str(ctx.recipientUserId);
  const recipient =
    recipientUserId !== null
      ? roster.find((r) => r.userId === recipientUserId)
      : roster.find((r) => r.email.toLowerCase() === row.toEmail.toLowerCase());
  if (recipient === undefined) return RECIPIENT_GONE;
  return { ...build(companyName), toEmail: recipient.email };
}

/**
 * T129 — a member (or staff on their behalf) submitted: "Awaiting marketing
 * review" to one roster recipient. Stale once marketing has acted — with the
 * flag off these rows wait in the outbox and drain on the flip, so a row for
 * an E-Blast already approved, formatted or closed must not arrive as "to
 * review" (the silent `request_superseded`).
 */
async function submittedMarketing(
  reads: EblastNotificationReads,
  tenant: TenantContext,
  broadcastId: BroadcastId,
  ctx: StoredContext<'eblast_submitted_marketing'>,
  row: EblastOutboxRow,
  locale: Locale,
): Promise<EblastPayload> {
  const broadcast = await reads.broadcastsRepo.withTx((tx) => reads.broadcastsRepo.findByIdInTx(tx, tenant.slug, broadcastId));
  if (broadcast === null) return GONE;
  if (broadcast.status !== 'submitted') return SUPERSEDED;
  return staffHandoff(reads, broadcast, ctx, row, (companyName) =>
    buildEblastSubmittedMarketingEmail({ locale, broadcastId, broadcastSubject: broadcast.subject, companyName }),
  );
}

/**
 * T131 — the approval clock (FR-022, FR-022a): `kind` ∈ reminder_day3 |
 * reminder_day7 | expiry_warning_day23 | expired_day30, `audience` ∈ member |
 * staff. The row is stale unless the E-Blast is still where the tick found it:
 * awaiting the member in the SAME round (a decision or a new version since
 * makes a reminder wrong), or — for the closure — expired in that round.
 *
 * STAFF: the four-field rule (FR-021b), via `staffHandoff`. MEMBER: to the
 * approval contact at their CURRENT address in their language, with the
 * version they were shown and the REMAINING timeline, counted from the day
 * that version was sent.
 */
async function approvalLifecycle(
  reads: EblastNotificationReads,
  tenant: TenantContext,
  broadcastId: BroadcastId,
  ctx: StoredContext<'eblast_approval_lifecycle'>,
  row: EblastOutboxRow,
  locale: Locale,
): Promise<EblastPayload> {
  const kind = ctx.kind;
  const audience = ctx.audience;
  const versionId = str(ctx.versionId);
  const round = int(ctx.round);
  if (!isLifecycleKind(kind)) return malformed(row, 'kind');
  if (audience !== 'member' && audience !== 'staff') return malformed(row, 'audience');
  if (versionId === null || round === null) return malformed(row, 'version_or_round');
  const read = await reads.broadcastsRepo.withTx(async (tx) => {
    const broadcast = await reads.broadcastsRepo.findByIdInTx(tx, tenant.slug, broadcastId);
    if (broadcast === null) return null;
    const versions = await reads.versionsRepo.listByBroadcast(tenant.slug, broadcastId, tx);
    const version = versions.find((v) => v.id === versionId);
    if (version === undefined) return null;
    const contacts =
      audience === 'member' ? await reads.portalRecipients.listActivePortalContacts(tenant, asMemberId(broadcast.requestedByMemberId), tx) : [];
    return { broadcast, version, contacts };
  });
  if (read === null) return GONE;
  const { broadcast, version, contacts } = read;
  const expectedStatus = kind === 'expired_day30' ? 'expired_no_member_response' : 'awaiting_member_approval';
  if (broadcast.status !== expectedStatus || broadcast.currentRound !== round || version.sentToMemberAt === null) {
    return SUPERSEDED;
  }
  if (audience === 'staff') {
    return staffHandoff(reads, broadcast, ctx, row, (companyName) =>
      buildEblastApprovalLifecycleEmail({
        audience: 'staff',
        kind,
        locale,
        broadcastId,
        broadcastSubject: broadcast.subject,
        companyName,
      }),
    );
  }
  const recipient = chooseApprovalRecipient(contacts, broadcast.submittedByUserId);
  if (recipient === null) return RECIPIENT_GONE;
  const email = buildEblastApprovalLifecycleEmail({
    audience: 'member',
    kind,
    locale: recipient.locale,
    broadcastId,
    broadcastSubject: version.subject,
    sentAt: version.sentToMemberAt,
  });
  return { ...email, toEmail: recipient.email };
}
