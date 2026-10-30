/**
 * Spec 141 — the one place a renewal reminder's gateway input is built, for
 * BOTH the first attempt (`dispatchEmailStep`) and the retry
 * (`retry-failed-reminders`).
 *
 * The renewals gateway sends the reminder event id as Resend's HTTP
 * `Idempotency-Key`. Resend answers a repeat of the SAME body with the
 * original message id (no second email) and a repeat with a DIFFERENT body
 * with 409 `invalid_idempotent_request` (MEASURED 2026-10-30). So the retry
 * must render exactly what the first attempt sent: every field comes from the
 * candidate and the reminder row, and the CTA — the redeem-vs-plain decision
 * and the token's `iat` — is taken at the row's `createdAt`, never at the tick.
 * A second hand-kept copy of this input is how the two paths would drift.
 *
 * Pure Application — no framework/ORM imports (Constitution Principle III).
 */
import { asCycleId } from '../../../domain/renewal-cycle';
import type { DispatchCandidate } from '../../ports/dispatch-candidate-repo';
import type { RenewalLinkTokenSigner } from '../../ports/renewal-link-token-signer';
import type { SendRenewalEmailInput } from '../../ports/renewal-gateway';
import { buildRenewalCtaUrl } from './build-renewal-redeem-link-url';

export function buildReminderSendInput(args: {
  readonly signer: RenewalLinkTokenSigner;
  readonly baseUrl: string;
  readonly tenantId: string;
  readonly candidate: DispatchCandidate & {
    readonly primaryContact: NonNullable<DispatchCandidate['primaryContact']>;
  };
  readonly stepId: string;
  readonly templateId: string;
  readonly reminderEventId: string;
  /** The reminder row's `created_at` — the instant the first attempt used. */
  readonly reminderCreatedAt: string;
}): SendRenewalEmailInput {
  const { cycle, member, primaryContact } = args.candidate;
  // Email-locale audit 2026-07-16 — member.preferred_locale (an EXPLICIT
  // member/admin choice, nullable) wins over contacts.preferred_language (NOT
  // NULL DEFAULT 'en' — indistinguishable from "never chose"). Fallback to
  // 'en' only when both are unset.
  const locale = member.preferredLocale ?? primaryContact.preferredLanguage ?? 'en';
  return {
    tenantId: args.tenantId,
    cycleId: asCycleId(cycle.cycleId),
    stepId: args.stepId,
    templateId: args.templateId,
    recipient: {
      memberId: member.memberId,
      toEmail: primaryContact.email,
      toName: `${primaryContact.firstName} ${primaryContact.lastName}`.trim(),
      preferredLocale: locale,
    },
    templateVariables: {
      member_first_name: primaryContact.firstName,
      member_company_name: member.companyName,
      cycle_expires_at: cycle.expiresAt,
      tier_bucket: cycle.tierAtCycleStart,
      step_id: args.stepId,
      // S1-P0-4 + go-live #8: signed-token redeem-link (auto-sign-in) when the
      // token will still be valid at expiry, else the authenticated renewal
      // page for early reminders whose redeem-link would expire first —
      // decided at `reminderCreatedAt` (spec 141).
      renewal_link_url: buildRenewalCtaUrl(args.signer, args.baseUrl, {
        tenantId: args.tenantId,
        memberId: member.memberId,
        cycleId: cycle.cycleId,
        now: new Date(args.reminderCreatedAt),
        expiresAtIso: cycle.expiresAt,
      }),
      // S1-P1-3: footer opt-out link target.
      preferences_url: `${args.baseUrl}/portal/preferences/renewals`,
    },
    idempotencyKey: args.reminderEventId,
  };
}
