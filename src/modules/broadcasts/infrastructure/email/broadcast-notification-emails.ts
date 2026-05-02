/**
 * F7 transactional notification email builders (Phase 8 — 2026-05-02).
 *
 * Render plain HTML + text payloads from the notifications_outbox row's
 * `context_data` for the F4 cron dispatcher (`/api/cron/outbox-dispatch`).
 * Two notification types covered today:
 *
 *   - `broadcast_delivered_notification` (FR-028 / AS3 — US5 catch-up):
 *     enqueued at `sending → sent` transition (webhook + 24h reconcile
 *     paths) by `enqueueDeliverySummaryEmail()`. Carries delivery /
 *     bounce / complaint counts, delivery rate, broadcast subject.
 *
 *   - `broadcast_failed_to_dispatch_notification` (FR-021 / AS2 — Phase 8):
 *     enqueued at `approved → failed_to_dispatch` transition by
 *     `enqueueDispatchFailureNotification()` after the 1h retry budget
 *     is exhausted OR a permanent (4xx / resource-missing / audience-
 *     empty-post-suppression) failure surfaces. Carries broadcast
 *     subject, scheduled-for timestamp, failure reason, broadcast id
 *     for deep-link.
 *
 * Locale strings come from `src/i18n/messages/{en,th,sv}.json` so the
 * portal surface + email surface stay in sync (one place to update
 * copy). Falls back to EN with a logger.error if a locale key is
 * missing — mirrors `renderBroadcastHtml` defensive lookup.
 *
 * Returns `BuiltEmail` shape compatible with the F4 dispatcher's
 * `BuiltPayload` interface.
 */
import enMessages from '@/i18n/messages/en.json' with { type: 'json' };
import thMessages from '@/i18n/messages/th.json' with { type: 'json' };
import svMessages from '@/i18n/messages/sv.json' with { type: 'json' };
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

export type BroadcastNotificationLocale = 'en' | 'th' | 'sv';

export interface BuiltEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

interface BroadcastDeliveredCopy {
  readonly subject: string;
  readonly greeting: string;
  readonly summaryIntro: string;
  readonly deliveredCount: string;
  readonly bouncedCount: string;
  readonly complainedCount: string;
  readonly deliveryRate: string;
  readonly footer: string;
  readonly viewBenefitsCta: string;
}

interface BroadcastFailedCopy {
  readonly subject: string;
  readonly greeting: string;
  readonly body1: string;
  readonly scheduledForLabel: string;
  readonly failureReasonLabel: string;
  readonly body2: string;
  readonly reassurance: string;
  readonly ctaRescheduleLabel: string;
  readonly footerSignOff: string;
}

const DELIVERED_COPY: Record<BroadcastNotificationLocale, BroadcastDeliveredCopy> = {
  en: (enMessages as { email: { broadcastDelivered: BroadcastDeliveredCopy } })
    .email.broadcastDelivered,
  th: (thMessages as { email: { broadcastDelivered: BroadcastDeliveredCopy } })
    .email.broadcastDelivered,
  sv: (svMessages as { email: { broadcastDelivered: BroadcastDeliveredCopy } })
    .email.broadcastDelivered,
};

const FAILED_COPY: Record<BroadcastNotificationLocale, BroadcastFailedCopy> = {
  en: (enMessages as { email: { broadcastFailedToDispatch: BroadcastFailedCopy } })
    .email.broadcastFailedToDispatch,
  th: (thMessages as { email: { broadcastFailedToDispatch: BroadcastFailedCopy } })
    .email.broadcastFailedToDispatch,
  sv: (svMessages as { email: { broadcastFailedToDispatch: BroadcastFailedCopy } })
    .email.broadcastFailedToDispatch,
};

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key)
      ? escape(String(vars[key]))
      : match,
  );
}

function broadcastDetailUrl(broadcastId: string): string {
  return `${env.app.baseUrl.replace(/\/$/, '')}/admin/broadcasts/${encodeURIComponent(broadcastId)}`;
}

function benefitsPortalUrl(): string {
  return `${env.app.baseUrl.replace(/\/$/, '')}/portal/benefits`;
}

function pickLocale<T>(map: Record<BroadcastNotificationLocale, T>, locale: BroadcastNotificationLocale, kind: string): T {
  const v = map[locale];
  if (v === undefined) {
    logger.error({ locale, kind }, 'broadcast_notification_locale_fallback_to_en');
    return map.en;
  }
  return v;
}

// =====================================================================
// broadcast_delivered_notification (FR-028 / AS3)
// =====================================================================

export interface BuildBroadcastDeliveredEmailInput {
  readonly toEmail: string;
  readonly broadcastId: string;
  readonly broadcastSubject: string;
  readonly delivered: number;
  readonly bounced: number;
  readonly complained: number;
  readonly total: number;
  readonly deliveryRate: number;
  readonly locale: BroadcastNotificationLocale;
}

export function buildBroadcastDeliveredEmail(
  input: BuildBroadcastDeliveredEmailInput,
): BuiltEmail {
  const copy = pickLocale(DELIVERED_COPY, input.locale, 'broadcastDelivered');
  const subject = fillTemplate(copy.subject, { subject: input.broadcastSubject });
  const greeting = copy.greeting;
  const intro = copy.summaryIntro;
  const delivered = fillTemplate(copy.deliveredCount, {
    count: input.delivered,
    total: input.total,
  });
  const bounced = fillTemplate(copy.bouncedCount, { count: input.bounced });
  const complained = fillTemplate(copy.complainedCount, { count: input.complained });
  const rate = fillTemplate(copy.deliveryRate, { rate: input.deliveryRate });
  const ctaUrl = benefitsPortalUrl();

  const html = `<!doctype html>
<html lang="${input.locale}">
  <head><meta charset="utf-8"><title>${escape(subject)}</title></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:40px auto;padding:24px;color:#111;">
    <h1 style="font-size:20px;margin:0 0 16px 0;">${escape(input.broadcastSubject)}</h1>
    <p style="line-height:1.6;">${escape(greeting)}</p>
    <p style="line-height:1.6;">${escape(intro)}</p>
    <ul style="line-height:1.8;padding-left:20px;">
      <li>${delivered}</li>
      <li>${bounced}</li>
      <li>${complained}</li>
      <li><strong>${rate}</strong></li>
    </ul>
    <p style="margin:24px 0;">
      <a href="${ctaUrl}" style="display:inline-block;background:#0b6bcb;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px;">${escape(copy.viewBenefitsCta)}</a>
    </p>
    <hr style="border:none;border-top:1px solid #eee;margin:32px 0 16px;" />
    <p style="color:#777;font-size:12px;">${escape(copy.footer)}</p>
  </body>
</html>`;

  const text =
    `${greeting}\n\n` +
    `${intro}\n\n` +
    `- ${stripTags(delivered)}\n- ${stripTags(bounced)}\n- ${stripTags(complained)}\n- ${stripTags(rate)}\n\n` +
    `${copy.viewBenefitsCta}: ${ctaUrl}\n\n` +
    `${copy.footer}\n`;

  return { subject, html, text };
}

// =====================================================================
// broadcast_failed_to_dispatch_notification (FR-021 / AS2 — Phase 8)
// =====================================================================

export interface BuildBroadcastFailedToDispatchEmailInput {
  readonly toEmail: string;
  readonly broadcastId: string;
  readonly broadcastSubject: string;
  readonly tenantDisplayName: string;
  readonly scheduledFor: string;
  readonly reason: string;
  readonly locale: BroadcastNotificationLocale;
}

export function buildBroadcastFailedToDispatchEmail(
  input: BuildBroadcastFailedToDispatchEmailInput,
): BuiltEmail {
  const copy = pickLocale(FAILED_COPY, input.locale, 'broadcastFailedToDispatch');
  const subject = fillTemplate(copy.subject, { subject: input.broadcastSubject });
  const body1 = fillTemplate(copy.body1, { tenantDisplayName: input.tenantDisplayName });
  const scheduledLine = fillTemplate(copy.scheduledForLabel, { scheduledFor: input.scheduledFor });
  const reasonLine = fillTemplate(copy.failureReasonLabel, { reason: input.reason });
  const ctaUrl = broadcastDetailUrl(input.broadcastId);

  const html = `<!doctype html>
<html lang="${input.locale}">
  <head><meta charset="utf-8"><title>${escape(subject)}</title></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:40px auto;padding:24px;color:#111;">
    <h1 style="font-size:20px;margin:0 0 16px 0;color:#b3261e;">${escape(input.broadcastSubject)}</h1>
    <p style="line-height:1.6;">${escape(copy.greeting)}</p>
    <p style="line-height:1.6;">${escape(body1)}</p>
    <p style="line-height:1.6;color:#555;font-size:14px;">${escape(scheduledLine)}<br>${escape(reasonLine)}</p>
    <p style="line-height:1.6;">${escape(copy.body2)}</p>
    <p style="line-height:1.6;background:#fff7e6;border-left:4px solid #f5a623;padding:12px 16px;border-radius:4px;">${escape(copy.reassurance)}</p>
    <p style="margin:24px 0;">
      <a href="${ctaUrl}" style="display:inline-block;background:#0b6bcb;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px;">${escape(copy.ctaRescheduleLabel)}</a>
    </p>
    <hr style="border:none;border-top:1px solid #eee;margin:32px 0 16px;" />
    <p style="color:#777;font-size:12px;">${escape(copy.footerSignOff)}</p>
  </body>
</html>`;

  const text =
    `${copy.greeting}\n\n` +
    `${body1}\n\n` +
    `${scheduledLine}\n${reasonLine}\n\n` +
    `${copy.body2}\n\n` +
    `${copy.reassurance}\n\n` +
    `${copy.ctaRescheduleLabel}: ${ctaUrl}\n\n` +
    `${copy.footerSignOff}\n`;

  return { subject, html, text };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}
