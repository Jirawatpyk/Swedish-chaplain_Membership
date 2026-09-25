/**
 * F119 T129a — the five approval-round hand-off emails × EN / TH / SV
 * (contracts/dashboard-and-notifications.md § 3, FR-021b, FR-024; data-model
 * § 7.3). One builder per `notification_type`; the outbox dispatcher arms
 * (T065, T129, T131) read the rows at send time and call these.
 *
 * Same shape as the F7 builders beside this file
 * (`broadcast-notification-emails.ts`): plain HTML + text, `escapeHtml` on
 * every value, copy from `email.eblastApproval` in the three message files so
 * the locales stay in `pnpm check:i18n`'s parity. (The task text says
 * `@react-email/components` "like the existing F7/F114 builders" — neither of
 * those uses it; the code precedent is followed.)
 *
 * **FR-021b — what each side may see.** A STAFF body carries exactly four
 * facts: the E-Blast's subject, the member company, the stage and a link.
 * The staff input types admit nothing else — no body, no reason, no note, no
 * send time — so a leak needs a type change, not a slip. The detail page,
 * behind the session and the permission check, is where the rest is read.
 * A MEMBER body says what changed, who acted ("the chamber" — never a staff
 * user's name), both send times when they differ, the day 3 / 7 / 23 / 30
 * timeline on the "version ready" body, and a link back.
 *
 * Times render in the tenant time zone (`env.tenant.timezone`), in the
 * recipient's locale. No italic anywhere (the Thai rule).
 */
import enMessages from '@/i18n/messages/en.json' with { type: 'json' };
import thMessages from '@/i18n/messages/th.json' with { type: 'json' };
import svMessages from '@/i18n/messages/sv.json' with { type: 'json' };
import type { Locale } from '@/i18n/config';
import { env } from '@/lib/env';
import { escapeHtml } from '@/lib/html-escape';
import { EMAIL_BRAND_PRIMARY } from '@/lib/email-brand';
import { MEMBER_APPROVAL_EXPIRY_DAYS } from '../../domain/approval/member-approval-expiry';
import {
  MEMBER_APPROVAL_REMINDER_DAYS,
  MEMBER_APPROVAL_TIMELINE_DAYS,
} from '../../domain/approval/approval-schedule-policy';
import { MEMBER_DECISION_KINDS, scheduleDiffers } from '../../domain/approval/member-decision';
import { EBLAST_APPROVAL_LIFECYCLE_KINDS } from '../../application/ports/eblast-notification-outbox-port';

export interface BuiltEblastEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/**
 * The `decision` discriminator of `eblast_member_decided_marketing`. Wider
 * than `MemberDecisionKind`: `withdrawn` is the whole-E-Blast withdrawal (a
 * member cancel from any in-progress stage); it carries no version, and no
 * round before the first one.
 *
 * DERIVED from the Domain tuple (#400 T3): it used to be a literal list that
 * only happened to match, so a decision kind added to `MEMBER_DECISION_KINDS`
 * would have been refused here as `malformed_context` at send time.
 */
export const EBLAST_MEMBER_DECIDED_KINDS = [...MEMBER_DECISION_KINDS, 'withdrawn'] as const;
export type EblastMemberDecidedKind = (typeof EBLAST_MEMBER_DECIDED_KINDS)[number];

/** The `kind` of `eblast_approval_lifecycle` (FR-022, FR-022a) — the port's own tuple (#400 T3). */
export const EBLAST_LIFECYCLE_KINDS = EBLAST_APPROVAL_LIFECYCLE_KINDS;
export type EblastLifecycleKind = (typeof EBLAST_LIFECYCLE_KINDS)[number];

interface TitledCopy {
  readonly subject: string;
  readonly heading: string;
}
interface LifecycleMemberKindCopy {
  readonly subject: string;
  readonly body: string;
}
interface EblastApprovalCopy {
  readonly common: {
    readonly footer: string;
    readonly subjectLabel: string;
    readonly companyLabel: string;
    readonly stageLabel: string;
    readonly staffCta: string;
    readonly staffDetailsNote: string;
  };
  readonly stage: {
    readonly awaitingMarketingReview: string;
    readonly memberApproved: string;
    readonly changesRequested: string;
    readonly withdrawn: string;
    readonly awaitingMemberApproval: string;
    readonly expired: string;
  };
  readonly submittedMarketing: TitledCopy;
  readonly memberDecidedMarketing: TitledCopy;
  readonly versionSentMember: {
    readonly subject: string;
    readonly heading: string;
    readonly intro: string;
    readonly noteHeading: string;
    readonly proposedSendAt: string;
    readonly noProposedSendAt: string;
    readonly cta: string;
  };
  readonly scheduleConfirmedMember: {
    readonly subject: string;
    readonly heading: string;
    readonly intro: string;
    readonly confirmedSendAt: string;
    readonly proposedSendAt: string;
    readonly notProposedTime: string;
    readonly cta: string;
  };
  readonly timeline: {
    readonly heading: string;
    readonly day3: string;
    readonly day7: string;
    readonly day23: string;
    readonly day30: string;
  };
  readonly lifecycle: {
    readonly member: Record<LifecycleKey, LifecycleMemberKindCopy> & {
      readonly ctaReview: string;
      readonly ctaList: string;
    };
    readonly staff: Record<LifecycleKey, TitledCopy>;
  };
}

type LifecycleKey = 'reminderDay3' | 'reminderDay7' | 'expiryWarningDay23' | 'expiredDay30';

const LIFECYCLE_KEY: Record<EblastLifecycleKind, LifecycleKey> = {
  reminder_day3: 'reminderDay3',
  reminder_day7: 'reminderDay7',
  expiry_warning_day23: 'expiryWarningDay23',
  expired_day30: 'expiredDay30',
};

const copyOf = (messages: unknown): EblastApprovalCopy =>
  (messages as { email: { eblastApproval: EblastApprovalCopy } }).email.eblastApproval;

const COPY: Record<Locale, EblastApprovalCopy> = {
  en: copyOf(enMessages),
  th: copyOf(thMessages),
  sv: copyOf(svMessages),
};

/**
 * The day marks of the member's approval clock, in order (FR-022, FR-022a) —
 * the Domain schedule policy's own thresholds, so the timeline an email states
 * and the day the cron acts cannot drift apart.
 */
const TIMELINE_DAYS = MEMBER_APPROVAL_TIMELINE_DAYS;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The lifecycle kinds' own day mark — the timeline a reminder restates starts after it. */
const LIFECYCLE_DAY: Record<EblastLifecycleKind, number> = {
  reminder_day3: MEMBER_APPROVAL_REMINDER_DAYS.day3,
  reminder_day7: MEMBER_APPROVAL_REMINDER_DAYS.day7,
  expiry_warning_day23: MEMBER_APPROVAL_REMINDER_DAYS.day23,
  expired_day30: MEMBER_APPROVAL_EXPIRY_DAYS,
};

/** A date + time in the tenant's time zone, in the recipient's locale. */
export function formatEblastEmailDate(at: Date, locale: Locale): string {
  const tag = locale === 'th' ? 'th-TH' : locale === 'sv' ? 'sv-SE' : 'en-GB';
  return new Intl.DateTimeFormat(tag, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: env.tenant.timezone,
  }).format(at);
}

/** `{name}` → value, unescaped (the caller escapes for HTML). An unknown name is left as-is. */
function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(vars, key) ? String(vars[key]) : match,
  );
}

const base = () => env.app.baseUrl.replace(/\/$/, '');
const staffLink = (broadcastId: string) => `${base()}/admin/broadcasts/${encodeURIComponent(broadcastId)}`;
const memberLink = (broadcastId: string) => `${base()}/portal/broadcasts/${encodeURIComponent(broadcastId)}`;
const memberListLink = () => `${base()}/portal/broadcasts`;

interface Block {
  readonly html: string;
  readonly text: string;
}
const para = (value: string): Block => ({ html: `<p style="line-height:1.6;">${escapeHtml(value)}</p>`, text: value });

function layout(
  locale: Locale,
  subject: string,
  heading: string,
  blocks: readonly Block[],
  cta: { readonly label: string; readonly url: string },
): BuiltEblastEmail {
  const footer = COPY[locale].common.footer;
  const html = `<!doctype html>
<html lang="${locale}">
  <head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:40px auto;padding:24px;color:#111;">
    <h1 style="font-size:20px;margin:0 0 16px 0;">${escapeHtml(heading)}</h1>
    ${blocks.map((b) => b.html).join('\n    ')}
    <p style="margin:24px 0;">
      <a href="${escapeHtml(cta.url)}" style="display:inline-block;background:${EMAIL_BRAND_PRIMARY};color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px;">${escapeHtml(cta.label)}</a>
    </p>
    <hr style="border:none;border-top:1px solid #eee;margin:32px 0 16px;" />
    <p style="color:#595959;font-size:12px;">${escapeHtml(footer)}</p>
  </body>
</html>`;
  const text = `${heading}\n\n${blocks.map((b) => b.text).join('\n\n')}\n\n${cta.label}: ${cta.url}\n\n— ${footer}\n`;
  return { subject, html, text };
}

// =====================================================================
// Staff — subject + member company + stage + link, and nothing else
// =====================================================================

/** The four facts a staff hand-off email may carry (FR-021b) — and no other field. */
export interface EblastStaffHandoffInput {
  readonly locale: Locale;
  readonly broadcastId: string;
  readonly broadcastSubject: string;
  readonly companyName: string;
}

function renderStaff(input: EblastStaffHandoffInput, titled: TitledCopy, stage: string): BuiltEblastEmail {
  const c = COPY[input.locale].common;
  const facts: Block = {
    html: `<p style="line-height:1.8;">
      <strong>${escapeHtml(c.subjectLabel)}:</strong> ${escapeHtml(input.broadcastSubject)}<br />
      <strong>${escapeHtml(c.companyLabel)}:</strong> ${escapeHtml(input.companyName)}<br />
      <strong>${escapeHtml(c.stageLabel)}:</strong> ${escapeHtml(stage)}
    </p>`,
    text: `${c.subjectLabel}: ${input.broadcastSubject}\n${c.companyLabel}: ${input.companyName}\n${c.stageLabel}: ${stage}`,
  };
  return layout(
    input.locale,
    fill(titled.subject, { subject: input.broadcastSubject }),
    titled.heading,
    [facts, para(c.staffDetailsNote)],
    { label: c.staffCta, url: staffLink(input.broadcastId) },
  );
}

/** `eblast_submitted_marketing` — a member submitted; marketing's turn (US5). */
export function buildEblastSubmittedMarketingEmail(input: EblastStaffHandoffInput): BuiltEblastEmail {
  const copy = COPY[input.locale];
  return renderStaff(input, copy.submittedMarketing, copy.stage.awaitingMarketingReview);
}

/** `eblast_member_decided_marketing` — the `decision` selects the stage wording; the reason is never shown. */
export function buildEblastMemberDecidedMarketingEmail(
  input: EblastStaffHandoffInput & { readonly decision: EblastMemberDecidedKind },
): BuiltEblastEmail {
  const copy = COPY[input.locale];
  const stage: Record<EblastMemberDecidedKind, string> = {
    approved: copy.stage.memberApproved,
    changes_requested: copy.stage.changesRequested,
    approval_withdrawn: copy.stage.changesRequested,
    withdrawn: copy.stage.withdrawn,
  };
  return renderStaff(input, copy.memberDecidedMarketing, stage[input.decision]);
}

// =====================================================================
// Member — what changed, who acted, the times, the way back
// =====================================================================

function timelineBlock(locale: Locale, sentAt: Date, afterDay: number): Block | null {
  const t = COPY[locale].timeline;
  const line: Record<(typeof TIMELINE_DAYS)[number], string> = { 3: t.day3, 7: t.day7, 23: t.day23, 30: t.day30 };
  const items = TIMELINE_DAYS.filter((day) => day > afterDay).map((day) =>
    fill(line[day], { date: formatEblastEmailDate(new Date(sentAt.getTime() + day * DAY_MS), locale) }),
  );
  if (items.length === 0) return null;
  return {
    html: `<p style="line-height:1.6;font-weight:600;margin-bottom:4px;">${escapeHtml(t.heading)}</p>
    <ul style="line-height:1.8;padding-left:20px;margin-top:0;">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`,
    text: `${t.heading}\n${items.map((i) => `- ${i}`).join('\n')}`,
  };
}

export interface EblastVersionSentMemberInput {
  readonly locale: Locale;
  readonly broadcastId: string;
  /** The subject of the version sent (marketing's formatted subject). */
  readonly versionSubject: string;
  readonly round: number;
  readonly noteToMember: string | null;
  readonly proposedSendAt: Date | null;
  /** When the version was sent — day 0 of the member's approval clock. */
  readonly sentAt: Date;
}

/** `eblast_version_sent_member` — round N is ready; the clock is stated the moment it starts. */
export function buildEblastVersionSentMemberEmail(input: EblastVersionSentMemberInput): BuiltEblastEmail {
  const copy = COPY[input.locale].versionSentMember;
  const blocks: Block[] = [para(fill(copy.intro, { subject: input.versionSubject }))];
  if (input.noteToMember !== null && input.noteToMember !== '') {
    blocks.push({
      html: `<p style="line-height:1.6;font-weight:600;margin-bottom:4px;">${escapeHtml(copy.noteHeading)}</p>
    <blockquote style="margin:0 0 16px 0;padding:12px 16px;border-left:4px solid #888;background:#f5f5f5;color:#333;">${escapeHtml(input.noteToMember).replaceAll('\n', '<br>')}</blockquote>`,
      text: `${copy.noteHeading}\n${input.noteToMember}`,
    });
  }
  blocks.push(
    para(
      input.proposedSendAt === null
        ? copy.noProposedSendAt
        : fill(copy.proposedSendAt, { when: formatEblastEmailDate(input.proposedSendAt, input.locale) }),
    ),
  );
  const timeline = timelineBlock(input.locale, input.sentAt, 0);
  if (timeline !== null) blocks.push(timeline);
  return layout(input.locale, copy.subject, fill(copy.heading, { round: input.round }), blocks, {
    label: copy.cta,
    url: memberLink(input.broadcastId),
  });
}

export interface EblastScheduleConfirmedMemberInput {
  readonly locale: Locale;
  readonly broadcastId: string;
  readonly broadcastSubject: string;
  readonly proposedSendAt: Date | null;
  readonly confirmedSendAt: Date;
}

/**
 * `eblast_schedule_confirmed_member` (FR-018): the confirmed time always; the
 * member's proposal beside it and "this is not the time you proposed" only
 * when they differ. No proposal at all counts as a difference
 * (`scheduleDiffers`), so the line shows and the proposal line does not.
 */
export function buildEblastScheduleConfirmedMemberEmail(input: EblastScheduleConfirmedMemberInput): BuiltEblastEmail {
  const copy = COPY[input.locale].scheduleConfirmedMember;
  const blocks: Block[] = [
    para(fill(copy.intro, { subject: input.broadcastSubject })),
    para(fill(copy.confirmedSendAt, { when: formatEblastEmailDate(input.confirmedSendAt, input.locale) })),
  ];
  if (scheduleDiffers(input.proposedSendAt, input.confirmedSendAt)) {
    if (input.proposedSendAt !== null) {
      blocks.push(para(fill(copy.proposedSendAt, { when: formatEblastEmailDate(input.proposedSendAt, input.locale) })));
    }
    blocks.push(para(copy.notProposedTime));
  }
  return layout(input.locale, copy.subject, copy.heading, blocks, { label: copy.cta, url: memberLink(input.broadcastId) });
}

// =====================================================================
// Lifecycle — reminders, the day-23 warning, the day-30 closure
// =====================================================================

export type EblastApprovalLifecycleInput =
  | (EblastStaffHandoffInput & { readonly audience: 'staff'; readonly kind: EblastLifecycleKind })
  | {
      readonly audience: 'member';
      readonly kind: EblastLifecycleKind;
      readonly locale: Locale;
      readonly broadcastId: string;
      readonly broadcastSubject: string;
      /** When the version was sent — day 0 of the clock. */
      readonly sentAt: Date;
    };

/**
 * `eblast_approval_lifecycle` — one builder, four `kind` bodies, two
 * audiences. The staff rendering obeys the four-field rule; the member
 * rendering restates the REMAINING timeline (none after closure).
 */
export function buildEblastApprovalLifecycleEmail(input: EblastApprovalLifecycleInput): BuiltEblastEmail {
  const copy = COPY[input.locale];
  const key = LIFECYCLE_KEY[input.kind];
  if (input.audience === 'staff') {
    const stage = input.kind === 'expired_day30' ? copy.stage.expired : copy.stage.awaitingMemberApproval;
    return renderStaff(input, copy.lifecycle.staff[key], stage);
  }
  const member = copy.lifecycle.member;
  const body = fill(member[key].body, {
    subject: input.broadcastSubject,
    sentDate: formatEblastEmailDate(input.sentAt, input.locale),
    expiresDate: formatEblastEmailDate(new Date(input.sentAt.getTime() + MEMBER_APPROVAL_EXPIRY_DAYS * DAY_MS), input.locale),
  });
  const blocks: Block[] = [para(body)];
  const timeline = timelineBlock(input.locale, input.sentAt, LIFECYCLE_DAY[input.kind]);
  if (timeline !== null) blocks.push(timeline);
  const closed = input.kind === 'expired_day30';
  return layout(input.locale, member[key].subject, member[key].subject, blocks, {
    label: closed ? member.ctaList : member.ctaReview,
    url: closed ? memberListLink() : memberLink(input.broadcastId),
  });
}
