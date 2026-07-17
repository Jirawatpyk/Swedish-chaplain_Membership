/** @jsxImportSource react */
/**
 * F8 Phase 4 Wave I3 / T100 — Resend transactional renewal gateway.
 *
 * Replaces the Wave I2c `stub-renewal-gateway.ts`. Renders the
 * `RenewalReminderEmail` React Email template into HTML + plain-text
 * fallback, then dispatches via the Resend SDK with an
 * `idempotency-key` header set from the reminder_event_id UUID.
 *
 * **NOT using F1's `emailSender`** because:
 *   1. F1's wrapper doesn't expose the `idempotency-key` header (Resend
 *      dedupes server-side on this — defence-in-depth alongside F8's
 *      DB-level `insertIfAbsent` idempotency primitive).
 *   2. F1's retry semantics are 1s/2s/4s with `lastError` capture; F8
 *      mirrors this in-place without sharing the wrapper. Same Resend
 *      API key per FR-019 transactional-surface alignment.
 *
 * Maps Resend error.name field to F8's `SendRenewalEmailError` discriminated
 * union per Wave I2c port shape:
 *   - validation_error / invalid_to_address → gateway_4xx (permanent)
 *   - unsubscribed                          → recipient_unsubscribed
 *   - email_not_verified                    → recipient_email_unverified
 *   - rate_limit_exceeded / 5xx / network   → gateway_5xx (retryable)
 */
import * as React from 'react';
import { Resend } from 'resend';
import { render } from '@react-email/components';
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { env } from '@/lib/env';
import {
  RenewalReminderEmail,
  type RenewalReminderEmailProps,
} from './email/templates/renewal-reminder-email';
import {
  TierUpgradeApprovalEmail,
  buildTierUpgradeApprovalSubject,
} from './email/templates/tier-upgrade-approval-email';
import {
  resolveCopy,
  resolveDueTrackCopy,
  interpolateCopy,
  TIER_LABELS,
  RENEWAL_REMINDER_TIERS,
  RENEWAL_REMINDER_OFFSETS,
  type RenewalReminderOffset,
  type RenewalReminderTier,
} from './email/templates/copy';
import { DueTrackWarningEmail } from './email/templates/due-track-warning-email';
import {
  DUE_TRACK_STEP_IDS,
  type DueTrackStepId,
} from '@/modules/renewals/domain/due-track';
import { formatDualFormatDate } from './email/templates/dual-format-date-footer';
import type {
  RenewalGateway,
  SendRenewalEmailError,
  SendRenewalEmailInput,
  SendRenewalEmailResult,
  SendTierUpgradeApprovalEmailInput,
} from '../application/ports/renewal-gateway';

/**
 * Default retry delays (1s/2s/4s per F1 emailSender pattern).
 * Tests override via `__setRetryDelaysForTesting()` to keep retry-path
 * tests fast (sub-100ms instead of 7s).
 */
const DEFAULT_RETRY_DELAYS_MS: ReadonlyArray<number> = [1_000, 2_000, 4_000];
let RETRY_DELAYS_MS: ReadonlyArray<number> = DEFAULT_RETRY_DELAYS_MS;

/** Test-only — override retry delays. Pass `null` to reset to defaults. */
export function __setRetryDelaysForTesting(
  delays: ReadonlyArray<number> | null,
): void {
  RETRY_DELAYS_MS = delays ?? DEFAULT_RETRY_DELAYS_MS;
}

const FALLBACK_FROM = 'SweCham <noreply@zyncdata.app>';

let cachedResend: Resend | null = null;

function resendClient(): Resend {
  if (!cachedResend) {
    cachedResend = new Resend(env.resend.apiKey);
  }
  return cachedResend;
}

function resolveFrom(): string {
  return env.resend.fromEmail ?? FALLBACK_FROM;
}

// ---------------------------------------------------------------------------
// stepId / templateId parsing
// ---------------------------------------------------------------------------

/**
 * Derive the offset_day from a stepId like `t-30.email`.
 * Returns null when the stepId doesn't follow the expected shape.
 */
export function deriveOffsetFromStepId(stepId: string): RenewalReminderOffset | null {
  const dotIdx = stepId.indexOf('.');
  const offsetPart = dotIdx === -1 ? stepId : stepId.slice(0, dotIdx);
  if (
    (RENEWAL_REMINDER_OFFSETS as readonly string[]).includes(offsetPart)
  ) {
    return offsetPart as RenewalReminderOffset;
  }
  return null;
}

/**
 * Derive the tier from a templateId like `renewal.t-30.thai-alumni`.
 * Returns null when the templateId doesn't carry a recognized tier.
 */
export function deriveTierFromTemplateId(
  templateId: string,
): RenewalReminderTier | null {
  for (const tier of RENEWAL_REMINDER_TIERS) {
    // Templates use hyphens for compound names (thai-alumni / start-up).
    const hyphenated = tier.replace(/_/g, '-');
    if (
      templateId.endsWith(`.${tier}`) ||
      templateId.endsWith(`.${hyphenated}`) ||
      templateId === tier ||
      templateId === hyphenated
    ) {
      return tier;
    }
  }
  return null;
}

function deriveDaysFromOffset(offset: RenewalReminderOffset): number {
  // Format: 't-30' → -30; 't+7' → 7; 't+0' → 0
  const sign = offset.charAt(1) === '-' ? -1 : 1;
  const num = Number(offset.slice(2));
  return Number.isFinite(num) ? sign * num : 0;
}

// ---------------------------------------------------------------------------
// Resend error mapping
// ---------------------------------------------------------------------------

/**
 * K5: Permanent-error allowlist — Resend error names that should NEVER
 * be retried for the FR-010a 24h budget. Defaulting unknown errors to
 * `gateway_5xx` (transient) was previously eating quota for permanent
 * configuration errors (`domain_not_verified`, `restricted_api_key`,
 * `quota_exceeded`, `from_blocked`) — they'd be retried for 24h while
 * never resolvable without operator intervention. The audit trail
 * would also report `failure_kind: 'gateway_5xx'` for what's really
 * a permanent config error, defeating the J9-M17 closed-set forensic
 * value.
 *
 * Match rule: `name.includes(...)` (lowercased) so Resend's
 * variants (`api_key_restricted`, `restricted_api_key`,
 * `daily_quota_exceeded`, `monthly_quota_exceeded`, etc.) all fold to
 * the right classification.
 */
const PERMANENT_RESEND_ERROR_PATTERNS: ReadonlyArray<string> = [
  'domain_not_verified',
  'domain_unverified',
  'restricted_api_key',
  'api_key_restricted',
  'quota_exceeded',
  'rate_limited_total', // Resend's permanent-quota signal (vs transient rate_limit)
  'from_blocked',
  'from_address_blocked',
  'sender_blocked',
];

function isPermanentResendName(nameLower: string): boolean {
  return PERMANENT_RESEND_ERROR_PATTERNS.some((p) => nameLower.includes(p));
}

/**
 * Round 6 W-004 — relocated to Domain layer at
 * `../domain/value-objects/sanitize-error-message.ts` so the
 * `acceptTierUpgrade` Application use-case can import it without
 * Application → Infrastructure boundary violation (Constitution
 * Principle III). The original implementation moved verbatim;
 * re-exported here for back-compat with existing Infrastructure
 * consumers (mapResendError, gateway error mapping).
 */
import { sanitizeResendErrorMessage } from '../domain/value-objects/sanitize-error-message';
export { sanitizeResendErrorMessage };

function mapResendError(
  resendError: { name?: string; message?: string },
): SendRenewalEmailError {
  const name = (resendError.name ?? 'unknown').toLowerCase();
  // K13-3 (SEC-R12-2): sanitise the message at the gateway boundary
  // BEFORE it propagates to `SendRenewalEmailError.message` →
  // `audit_log.payload.failure_message`. Account-scoped identifiers
  // would otherwise persist for 5 years.
  const message = sanitizeResendErrorMessage(
    resendError.message ?? 'unknown resend error',
  );
  if (name.includes('validation') || name.includes('invalid_to_address')) {
    return { kind: 'gateway_4xx', retryable: false, message };
  }
  if (name.includes('unsubscribed')) {
    return { kind: 'recipient_unsubscribed' };
  }
  if (name.includes('email_not_verified')) {
    return { kind: 'recipient_email_unverified' };
  }
  // K5: Known-permanent allowlist (closes a 24h-retry-storm hazard for
  // permanent config errors that the previous catch-all-5xx default
  // would otherwise hammer).
  if (isPermanentResendName(name)) {
    return { kind: 'gateway_4xx', retryable: false, message };
  }
  // Truly-unknown name → log a WARN + emit metrics counter so the team
  // can extend the allowlist before the next retry storm. The default
  // classification stays transient (gateway_5xx) — defaulting NEW
  // Resend error codes to permanent could starve legitimate retries
  // during a Resend incident with novel error names.
  if (name === 'unknown' || name === '' || resendError.name === undefined) {
    // Best-effort: empty/missing name is genuine "we don't know".
  } else {
    // K12-5 (SEC-K-2): log ONLY the error name — the freeform message
    // from the Resend SDK can leak account-scoped identifiers (sending
    // domain, API-key prefix, account ID) on novel error shapes; the
    // `*.message` field is NOT covered by REDACT_PATHS today. Name is
    // bounded enum-like and safe.
    logger.warn(
      { resendErrorName: resendError.name },
      'resend.renewals.send.unknown_error_name_classified_as_transient',
    );
    // K12-4 (REL-K-2): metrics counter pages on-call without requiring
    // log-grep. Alert rule: non-zero rate over 5 min.
    renewalsMetrics.unknownResendErrorName(resendError.name);
  }
  return { kind: 'gateway_5xx', retryable: true, message };
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Shared Resend dispatch (retry budget + error mapping)
// ---------------------------------------------------------------------------

/**
 * 066 §3.2(2) extract-function — the Resend send loop (retry budget,
 * error mapping, replyTo threading, idempotency header) shared by the
 * tier-ladder path and the due-track branch of `sendRenewalEmail`.
 * Behaviour is verbatim the pre-066 loop; only the subject/html/text
 * assembly differs per caller.
 */
async function sendViaResendWithRetry(args: {
  readonly input: SendRenewalEmailInput;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}): Promise<Result<SendRenewalEmailResult, SendRenewalEmailError>> {
  const { input, subject, html, text } = args;
  const resend = resendClient();
  const from = resolveFrom();
  let lastError: SendRenewalEmailError | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await resend.emails.send({
        from,
        to: input.recipient.toEmail,
        subject,
        html,
        text,
        headers: { 'idempotency-key': input.idempotencyKey },
        ...(input.replyToEmail
          ? {
              replyTo: input.replyToDisplayName
                ? `${input.replyToDisplayName} <${input.replyToEmail}>`
                : input.replyToEmail,
            }
          : {}),
      });
      if (response.error) {
        const mapped = mapResendError(response.error);
        // Permanent failures abort immediately. Transient (gateway_5xx)
        // falls through to retry.
        if (mapped.kind !== 'gateway_5xx') {
          return err(mapped);
        }
        lastError = mapped;
      } else if (response.data?.id) {
        if (attempt > 0) {
          logger.info(
            {
              tenantId: input.tenantId,
              deliveryId: response.data.id,
              attempt,
            },
            'resend.renewals.send.retry_succeeded',
          );
        }
        return ok({
          deliveryId: response.data.id,
          dispatchedAt: new Date().toISOString(),
        });
      }
    } catch (e) {
      // K13-3 (SEC-R12-2): sanitise the SDK exception message before
      // it lands in lastError.message → audit_log.failure_message.
      // Resend SDK exception strings can include sending-domain or
      // API-key fragments depending on the network failure mode.
      lastError = {
        kind: 'gateway_5xx',
        retryable: true,
        message: sanitizeResendErrorMessage(
          e instanceof Error ? e.message : 'unknown',
        ),
      };
      logger.warn(
        {
          // K13-5 (CON-R12-2): Error instance for pino's `err`
          // serializer (stack + type capture).
          err: e instanceof Error ? e : new Error(String(e)),
          tenantId: input.tenantId,
          attempt,
        },
        'resend.renewals.send.exception',
      );
    }
    const delayMs = RETRY_DELAYS_MS[attempt];
    if (delayMs !== undefined) {
      await delay(delayMs);
    }
  }

  logger.error(
    {
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      lastErrorKind: lastError?.kind ?? 'unknown',
    },
    'resend.renewals.send.exhausted_retries',
  );
  return err(
    lastError ?? {
      kind: 'gateway_5xx',
      retryable: true,
      message: 'exhausted retries',
    },
  );
}

/**
 * 066 §3.2(2) — DUE-TRACK send path. Tier-less: copy keyed by stepId +
 * locale only; renders `DueTrackWarningEmail` (bill-due framing, no expiry
 * footer, no preferences link — contractual dunning bypasses the opt-out).
 */
async function sendDueTrackEmail(
  input: SendRenewalEmailInput,
  stepId: DueTrackStepId,
): Promise<Result<SendRenewalEmailResult, SendRenewalEmailError>> {
  // Same dead-CTA guard as the ladder path (go-live #11).
  const payLinkUrl = String(input.templateVariables.renewal_link_url ?? '');
  if (payLinkUrl.trim() === '') {
    logger.warn(
      { stepId: input.stepId, tenantId: input.tenantId },
      'resend.renewals.send.missing_renewal_link_url',
    );
    return err({
      kind: 'template_variables_missing',
      missing: ['renewal_link_url'],
    });
  }

  const locale = input.recipient.preferredLocale;
  const memberFirstName = String(
    input.templateVariables.member_first_name ?? input.recipient.toName ?? '',
  );
  const memberCompanyName = String(
    input.templateVariables.member_company_name ?? '',
  );
  const copy = resolveDueTrackCopy(stepId, locale);
  const subject = interpolateCopy(copy.subject, {
    firstName: memberFirstName,
    companyName: memberCompanyName,
  });

  const props = {
    locale,
    stepId,
    memberFirstName,
    memberCompanyName,
    payLinkUrl,
  };
  let html: string;
  let text: string;
  try {
    [html, text] = await Promise.all([
      render(<DueTrackWarningEmail {...props} />),
      render(<DueTrackWarningEmail {...props} />, { plainText: true }),
    ]);
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        tenantId: input.tenantId,
        stepId,
      },
      'resend.renewals.send.render_failed',
    );
    return err({
      kind: 'gateway_4xx',
      retryable: false,
      message: sanitizeResendErrorMessage(
        e instanceof Error ? e.message : 'render failed',
      ),
    });
  }

  return sendViaResendWithRetry({ input, subject, html, text });
}

function asDueTrackStepId(stepId: string): DueTrackStepId | null {
  return (DUE_TRACK_STEP_IDS as readonly string[]).includes(stepId)
    ? (stepId as DueTrackStepId)
    : null;
}

// ---------------------------------------------------------------------------
// Gateway implementation
// ---------------------------------------------------------------------------

export const resendTransactionalRenewalGateway: RenewalGateway = {
  async sendRenewalEmail(
    input: SendRenewalEmailInput,
  ): Promise<Result<SendRenewalEmailResult, SendRenewalEmailError>> {
    // 0. 066 §3.2(2) — DUE-TRACK branch. Due-anchored steps are tier-less
    // and keyed by stepId alone; they bypass the tier×offset parsing below
    // (deriveOffsetFromStepId would reject 'due+30' and permanently fail
    // the send as template_variables_missing).
    const dueTrackStepId = asDueTrackStepId(input.stepId);
    if (dueTrackStepId) {
      return sendDueTrackEmail(input, dueTrackStepId);
    }

    // 1. Parse stepId / templateId → derive offset + tier for copy resolution.
    const offset = deriveOffsetFromStepId(input.stepId);
    if (!offset) {
      logger.warn(
        { stepId: input.stepId },
        'resend.renewals.send.unknown_step_id',
      );
      return err({
        kind: 'template_variables_missing',
        missing: ['offset_day'],
      });
    }
    const tier = deriveTierFromTemplateId(input.templateId);
    if (!tier) {
      logger.warn(
        { templateId: input.templateId },
        'resend.renewals.send.unknown_template_id',
      );
      return err({
        kind: 'template_variables_missing',
        missing: ['tier'],
      });
    }

    // go-live #11 — every renewal email MUST carry a CTA url (a redeem-link for
    // reminders within the token TTL, else the authenticated renewal page). An
    // empty url renders a dead CTA button, so fail the send (classified permanent
    // by isPermanentGatewayError → no pointless retries) instead of shipping a
    // broken email. Defence-in-depth: dispatch + retry always set it via
    // buildRenewalCtaUrl.
    const renewalLinkUrl = String(
      input.templateVariables.renewal_link_url ?? '',
    );
    if (renewalLinkUrl.trim() === '') {
      logger.warn(
        { stepId: input.stepId, tenantId: input.tenantId },
        'resend.renewals.send.missing_renewal_link_url',
      );
      return err({
        kind: 'template_variables_missing',
        missing: ['renewal_link_url'],
      });
    }

    // 2. Build template props from gateway input + interpolation variables.
    const props: RenewalReminderEmailProps = {
      locale: input.recipient.preferredLocale,
      tier,
      offset,
      memberFirstName: String(
        input.templateVariables.member_first_name ??
          input.recipient.toName ??
          '',
      ),
      memberCompanyName: String(
        input.templateVariables.member_company_name ?? '',
      ),
      expiresAtIso: String(input.templateVariables.cycle_expires_at ?? ''),
      daysUntilExpiry: Number(
        input.templateVariables.days_until_expiry ?? deriveDaysFromOffset(offset),
      ),
      renewalLinkUrl,
      // S1-P1-3 — opt-out link in the footer (empty → no link rendered).
      preferencesUrl: String(input.templateVariables.preferences_url ?? ''),
    };

    // 3. Compute subject (interpolated; same formula as the template body).
    const { copy, usedFallback } = resolveCopy(tier, offset, props.locale);
    if (usedFallback) {
      logger.warn(
        {
          tenantId: input.tenantId,
          tier,
          offset,
          locale: props.locale,
        },
        'resend.renewals.send.locale_fallback_to_en',
      );
    }
    const tierLabel = TIER_LABELS[props.locale][tier];
    const { gregorian, thaiBE } = formatDualFormatDate(
      props.expiresAtIso,
      props.locale,
    );
    const expiresAtForBody =
      props.locale === 'th' ? `${thaiBE} (${gregorian})` : gregorian;
    const subject = interpolateCopy(copy.subject, {
      firstName: props.memberFirstName,
      companyName: props.memberCompanyName,
      tier: tierLabel,
      daysUntilExpiry: Math.abs(props.daysUntilExpiry),
      expiresAt: expiresAtForBody,
    });

    // 4. Render React Email template → HTML + plain-text.
    // J5-M3: parallelise the two renders. `@react-email/components`'
    // `render` is async + traverses the React tree — calling it
    // sequentially doubles wall-clock render time per email. With
    // DISPATCH_CONCURRENCY=10 in dispatchRenewalCycle and the 5k
    // perf benchmark (T115), halving the per-email render shaves
    // measurable time off the cron pass duration.
    let html: string;
    let text: string;
    try {
      [html, text] = await Promise.all([
        render(<RenewalReminderEmail {...props} />),
        render(<RenewalReminderEmail {...props} />, { plainText: true }),
      ]);
    } catch (e) {
      logger.error(
        {
          // K13-5 (CON-R12-2): Error instance for pino's `err`
          // serializer (stack + type capture).
          err: e instanceof Error ? e : new Error(String(e)),
          tenantId: input.tenantId,
          tier,
          offset,
        },
        'resend.renewals.send.render_failed',
      );
      // K13-3 (SEC-R12-2): sanitise the React Email render exception
      // message before it lands in the Result envelope (then
      // audit_log.failure_message). Render errors typically don't
      // contain account-scoped identifiers but we apply the same
      // discipline here as for Resend SDK errors — defence in depth.
      return err({
        kind: 'gateway_4xx',
        retryable: false,
        message: sanitizeResendErrorMessage(
          e instanceof Error ? e.message : 'render failed',
        ),
      });
    }

    // 5. Dispatch via Resend SDK with retry budget (shared helper — 066
    // extract-function; loop semantics unchanged, verified by this file's
    // retry/error-mapping test suite).
    return sendViaResendWithRetry({ input, subject, html, text });
  },

  async sendTierUpgradeApprovalEmail(
    input: SendTierUpgradeApprovalEmailInput,
  ): Promise<Result<SendRenewalEmailResult, SendRenewalEmailError>> {
    const subject = buildTierUpgradeApprovalSubject(
      input.recipient.preferredLocale,
      { planName: input.targetPlanName },
    );

    let html: string;
    let text: string;
    try {
      [html, text] = await Promise.all([
        render(
          <TierUpgradeApprovalEmail
            locale={input.recipient.preferredLocale}
            memberFirstName={input.recipient.toName ?? ''}
            memberCompanyName={input.memberCompanyName}
            targetPlanName={input.targetPlanName}
            effectiveAtIso={input.effectiveAtIso}
            portalUrl={`${env.app.baseUrl}/portal`}
          />,
        ),
        render(
          <TierUpgradeApprovalEmail
            locale={input.recipient.preferredLocale}
            memberFirstName={input.recipient.toName ?? ''}
            memberCompanyName={input.memberCompanyName}
            targetPlanName={input.targetPlanName}
            effectiveAtIso={input.effectiveAtIso}
            portalUrl={`${env.app.baseUrl}/portal`}
          />,
          { plainText: true },
        ),
      ]);
    } catch (e) {
      logger.error(
        {
          err: e instanceof Error ? e : new Error(String(e)),
          tenantId: input.tenantId,
        },
        'resend.renewals.tier_upgrade_approval.render_failed',
      );
      return err({
        kind: 'gateway_4xx',
        retryable: false,
        message: sanitizeResendErrorMessage(
          e instanceof Error ? e.message : 'render failed',
        ),
      });
    }

    const resend = resendClient();
    const from = resolveFrom();
    let lastError: SendRenewalEmailError | null = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await resend.emails.send({
          from,
          to: input.recipient.toEmail,
          subject,
          html,
          text,
          headers: { 'idempotency-key': input.idempotencyKey },
        });
        if (response.error) {
          const mapped = mapResendError(response.error);
          if (mapped.kind !== 'gateway_5xx') {
            return err(mapped);
          }
          lastError = mapped;
        } else if (response.data?.id) {
          return ok({
            deliveryId: response.data.id,
            dispatchedAt: new Date().toISOString(),
          });
        }
      } catch (e) {
        lastError = {
          kind: 'gateway_5xx',
          retryable: true,
          message: sanitizeResendErrorMessage(
            e instanceof Error ? e.message : 'unknown',
          ),
        };
        logger.warn(
          {
            err: e instanceof Error ? e : new Error(String(e)),
            tenantId: input.tenantId,
            attempt,
          },
          'resend.renewals.tier_upgrade_approval.exception',
        );
      }
      const delayMs = RETRY_DELAYS_MS[attempt];
      if (delayMs !== undefined) {
        await delay(delayMs);
      }
    }

    logger.error(
      {
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
        lastErrorKind: lastError?.kind ?? 'unknown',
      },
      'resend.renewals.tier_upgrade_approval.exhausted_retries',
    );
    return err(
      lastError ?? {
        kind: 'gateway_5xx',
        retryable: true,
        message: 'exhausted retries',
      },
    );
  },
};
