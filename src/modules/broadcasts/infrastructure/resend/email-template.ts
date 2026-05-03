/**
 * T147 — Broadcast email HTML template (F7 US4).
 *
 * Renders the final HTML body that goes into Resend Broadcasts'
 * `broadcasts.create({html})`. Wraps the member-authored sanitised
 * inner HTML with a chamber-branded header (subject), separator, and a
 * locale-aware footer carrying the unsubscribe CTA + tenant identifier.
 *
 * Per-recipient unsubscribe URL strategy
 * --------------------------------------
 * Resend Broadcasts API ships ONE HTML body for the entire audience —
 * the `audiences.contacts.create` surface only takes `email`,
 * `firstName`, `lastName`, `unsubscribed`; there is no arbitrary
 * per-contact merge field for our HMAC-signed token. Two surfaces share
 * the work:
 *
 *   1. **Body CTA** — uses Resend's built-in `{{{RESEND_UNSUBSCRIBE_URL}}}`
 *      merge tag. Resend substitutes per-recipient at send time;
 *      clicking lands on Resend's hosted unsubscribe page; their hosted
 *      page emits `email.complained` / `email.unsubscribed` webhook.
 *      F7 US5 `process-webhook-event.ts` (T154) mirrors that into our
 *      `marketing_unsubscribes` table — so the suppression list under
 *      our control still grows correctly.
 *
 *   2. **List-Unsubscribe RFC 8058 header + admin direct links** — use
 *      `signUnsubscribeUrl(...)` (exported below) to mint a per-recipient
 *      HMAC-signed URL pointing to OUR `/unsubscribe/[token]` route. The
 *      route verifies HMAC, resolves the tenant context, runs
 *      `unsubscribeRecipient`, and renders the bilingual confirmation
 *      page directly (no Resend round-trip). Currently consumed by:
 *        - `signListUnsubscribePostUrl(...)` (below) — emits the
 *          one-click opt-out URL for the `List-Unsubscribe-Post` header.
 *        - Admin "share unsubscribe link" affordance in the broadcast
 *          detail view (US2 surface).
 *      Future per-recipient batch send (`emails.send` loop, post-MVP)
 *      will inject this URL directly into the body footer instead of
 *      relying on Resend's merge tag. The plumbing is in place today.
 *
 * Both surfaces convergent: any unsubscribe — whether via Resend's
 * hosted page or our `/unsubscribe/[token]` route — lands a row in
 * `marketing_unsubscribes` and protects the recipient on subsequent
 * dispatches (FR-017 + FR-031).
 *
 * Pure Infrastructure — only Domain types + env + token signer. No
 * framework / ORM imports.
 */
import enMessages from '@/i18n/messages/en.json' with { type: 'json' };
import thMessages from '@/i18n/messages/th.json' with { type: 'json' };
import svMessages from '@/i18n/messages/sv.json' with { type: 'json' };
import { logger } from '@/lib/logger';
import type { TenantSlug } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import type { EmailLower } from '../../domain/value-objects/email-lower';
import { unsubscribeTokenSigner } from '../unsubscribe-token/hmac-signer';

export type BroadcastLocale = 'en' | 'th' | 'sv';

interface FooterStrings {
  readonly receivedBecause: string;
  readonly unsubscribeCta: string;
  readonly unsubscribeSuffix: string;
  readonly physicalAddress: string;
}

const FOOTER_STRINGS: Record<BroadcastLocale, FooterStrings> = {
  en: (enMessages as { email: { broadcastFooter: FooterStrings } }).email
    .broadcastFooter,
  th: (thMessages as { email: { broadcastFooter: FooterStrings } }).email
    .broadcastFooter,
  sv: (svMessages as { email: { broadcastFooter: FooterStrings } }).email
    .broadcastFooter,
};

/**
 * Resend's per-recipient merge tag. At send time Resend replaces the
 * literal `{{{RESEND_UNSUBSCRIBE_URL}}}` with a hosted URL unique to
 * each recipient. We embed it verbatim in the HTML; consumer code does
 * NOT need to escape it (Resend treats triple-brace tokens as raw
 * template substitutions outside HTML escaping).
 */
const RESEND_UNSUBSCRIBE_MERGE_TAG = '{{{RESEND_UNSUBSCRIBE_URL}}}';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key)
      ? escapeHtml(vars[key]!)
      : match,
  );
}

/**
 * Renders the final broadcast HTML for the Resend Broadcasts `html`
 * field. The footer's primary unsubscribe CTA points to Resend's
 * hosted page via the merge tag (per-recipient substitution). The
 * `physicalAddress` line satisfies CAN-SPAM / PDPA marketing-mail
 * disclosure expectations.
 *
 * NOTE — synthetic "{tenantDisplayName}, address on file" placeholder
 * stands in for the real postal address. The real value will land on
 * `tenant_invoice_settings.physical_address` once that column is added
 * (see `docs/phases-plan.md` SaaS layer — currently no row exposes a
 * postal address; tracked under the white-label / multi-tenant onboarding
 * thread, not a discrete F-feature). Until then the tenant display name
 * is the minimum identifier per CAN-SPAM § 5(a)(5). Round 5 review fix —
 * removed the vague `TODO(F12)` reference (no F12 in the canonical 14-
 * feature plan; was confusing future contributors).
 *
 * The member-authored `bodyHtml` MUST already be sanitised by the
 * Application-layer DOMPurify pass before reaching this renderer — we
 * embed it as-is.
 */
export interface RenderBroadcastHtmlInput {
  readonly subject: string;
  readonly bodyHtml: string;
  readonly tenantDisplayName: string;
  readonly locale: BroadcastLocale;
}

export function renderBroadcastHtml(input: RenderBroadcastHtmlInput): string {
  // Defensive lookup: TS already pins `input.locale` to BroadcastLocale,
  // but `noUncheckedIndexedAccess: true` requires a runtime fallback so a
  // future i18n-key rename surfaces as a logged degrade-to-EN rather than
  // a TypeError inside the Resend gateway's withRetry wrapper.
  const f = FOOTER_STRINGS[input.locale] ?? FOOTER_STRINGS.en;
  if (FOOTER_STRINGS[input.locale] === undefined) {
    logger.error(
      { locale: input.locale },
      'broadcast_template_locale_fallback_to_en',
    );
  }
  const safeSubject = escapeHtml(input.subject);
  const safeTenantName = escapeHtml(input.tenantDisplayName);

  const receivedLine = fillTemplate(f.receivedBecause, {
    tenantDisplayName: input.tenantDisplayName,
  });
  const physicalLine = fillTemplate(f.physicalAddress, {
    tenantDisplayName: input.tenantDisplayName,
  });

  return [
    '<!doctype html>',
    `<html lang="${input.locale}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<title>${safeSubject}</title>`,
    '</head>',
    '<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;background:#f6f6f6">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f6">',
    '<tr><td align="center" style="padding:24px 12px">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">',
    `<tr><td style="padding:24px 32px 16px 32px;border-bottom:1px solid #eee"><strong style="font-size:14px;color:#666">${safeTenantName}</strong></td></tr>`,
    `<tr><td style="padding:24px 32px;font-size:15px;line-height:1.6;color:#1a1a1a">${input.bodyHtml}</td></tr>`,
    '<tr><td style="padding:16px 32px 24px 32px;border-top:1px solid #eee;font-size:11px;line-height:1.5;color:#888">',
    `<p style="margin:0 0 8px 0">${receivedLine}</p>`,
    `<p style="margin:0 0 8px 0"><a href="${RESEND_UNSUBSCRIBE_MERGE_TAG}" style="color:#666;text-decoration:underline">${escapeHtml(f.unsubscribeCta)}</a> ${escapeHtml(f.unsubscribeSuffix)}</p>`,
    `<p style="margin:0">${physicalLine}</p>`,
    '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('');
}

/**
 * Mint a per-recipient HMAC-signed unsubscribe URL pointing to OUR
 * `/unsubscribe/[token]` route. Used by:
 *   - List-Unsubscribe RFC 8058 header generator (`signListUnsubscribePostUrl`)
 *   - Admin "share unsubscribe link" affordance
 *   - Future per-recipient `emails.send` body-injection path
 *
 * `tenantHost` is the recipient-facing host (e.g. `swecham.zyncdata.app`).
 * Production deployments pass a fully-qualified host with TLS; tests pass
 * `localhost:3100`.
 */
export interface SignUnsubscribeUrlInput {
  readonly tenantId: TenantSlug;
  readonly broadcastId: BroadcastId;
  readonly emailLower: EmailLower;
  readonly tenantHost: string;
  readonly locale: BroadcastLocale;
}

export function signUnsubscribeUrl(input: SignUnsubscribeUrlInput): string {
  const token = unsubscribeTokenSigner.sign({
    tenantId: input.tenantId,
    broadcastId: input.broadcastId,
    emailLower: input.emailLower,
    lang: input.locale,
  });
  // The `lang` query param is informational only — the token's signed
  // `lang` claim takes precedence in the route handler.
  return `https://${input.tenantHost}/unsubscribe/${encodeURIComponent(token)}?lang=${input.locale}`;
}

/**
 * Build the `List-Unsubscribe` + `List-Unsubscribe-Post` header values
 * for RFC 8058 one-click opt-out. Mail clients (Gmail / Apple Mail /
 * Outlook) honour these headers to render a one-click unsubscribe button
 * outside the email body. The POST URL is HMAC-signed so a forger cannot
 * unsubscribe an arbitrary email without first compromising
 * `UNSUBSCRIBE_TOKEN_SECRET`.
 *
 * Output:
 *   List-Unsubscribe: <https://host/unsubscribe/TOKEN>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 */
export function buildListUnsubscribeHeaders(
  input: SignUnsubscribeUrlInput,
): {
  readonly listUnsubscribe: string;
  readonly listUnsubscribePost: string;
} {
  return {
    listUnsubscribe: `<${signUnsubscribeUrl(input)}>`,
    listUnsubscribePost: 'List-Unsubscribe=One-Click',
  };
}
