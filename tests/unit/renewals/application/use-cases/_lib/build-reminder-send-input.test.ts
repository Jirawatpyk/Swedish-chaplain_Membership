/**
 * Spec 141 — the one builder both the first attempt (`dispatchEmailStep`) and
 * the retry (`retry-failed-reminders`) use for a reminder's gateway input.
 *
 * The retry must render the body the first attempt sent, byte for byte, so
 * Resend's Idempotency-Key returns the original message instead of a 409.
 * Two hand-kept copies of this input drifted silently is how that breaks;
 * one builder, decided at the reminder row's `createdAt`, is how it holds.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildReminderSendInput } from '@/modules/renewals/application/use-cases/_lib/build-reminder-send-input';
import type { DispatchCandidate } from '@/modules/renewals/application/ports/dispatch-candidate-repo';
import type { RenewalLinkTokenSigner } from '@/modules/renewals/application/ports/renewal-link-token-signer';

const signer = {
  sign: vi.fn((payload: { iat: number }) => ({ token: `tok-${payload.iat}`, payload, tokenSha256: new Uint8Array(32) })),
} as unknown as RenewalLinkTokenSigner;

const candidate = {
  cycle: { cycleId: '00000000-0000-0000-0000-000000000c01', expiresAt: '2026-06-14T00:00:00.000Z', tierAtCycleStart: 'regular' },
  member: { memberId: 'm-1', companyName: 'Acme Co', preferredLocale: null },
  primaryContact: { email: 'admin@acme.example', firstName: 'Anna', lastName: 'Adm', preferredLanguage: 'sv' },
} as unknown as DispatchCandidate & { primaryContact: NonNullable<DispatchCandidate['primaryContact']> };

const base = {
  signer,
  baseUrl: 'https://swecham.example',
  tenantId: 'tenanta',
  candidate,
  stepId: 't-30.email',
  templateId: 'renewal.t-30.regular',
  reminderEventId: 'rem-1',
};

describe('buildReminderSendInput (spec 141)', () => {
  it('is a pure function of its inputs: two calls at the same createdAt are deep-equal', () => {
    const a = buildReminderSendInput({ ...base, reminderCreatedAt: '2026-05-15T00:00:00.000Z' });
    const b = buildReminderSendInput({ ...base, reminderCreatedAt: '2026-05-15T00:00:00.000Z' });
    expect(a).toEqual(b);
    expect(a.idempotencyKey).toBe('rem-1');
    expect(a.recipient).toEqual({ memberId: 'm-1', toEmail: 'admin@acme.example', toName: 'Anna Adm', preferredLocale: 'sv' });
  });

  it('decides and signs the CTA at createdAt: a redeem-link whose token iat is createdAt', () => {
    // createdAt 05-15 + 30-day TTL reaches the 06-14 expiry → redeem-link.
    const input = buildReminderSendInput({ ...base, reminderCreatedAt: '2026-05-15T00:00:00.000Z' });
    const iat = Math.floor(Date.parse('2026-05-15T00:00:00.000Z') / 1000);
    expect(String(input.templateVariables['renewal_link_url'])).toBe(
      `https://swecham.example/api/portal/renewal/redeem-link?t=tok-${iat}`,
    );
  });

  it('a createdAt too early for the token to outlive the cycle gives the plain portal link', () => {
    const input = buildReminderSendInput({ ...base, reminderCreatedAt: '2026-05-14T00:00:00.000Z' });
    expect(input.templateVariables['renewal_link_url']).toBe('https://swecham.example/portal/renewal/m-1');
  });
});
