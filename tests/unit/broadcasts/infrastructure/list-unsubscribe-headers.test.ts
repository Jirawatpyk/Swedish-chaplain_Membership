/**
 * RFC 8058 List-Unsubscribe on E-Blasts — what we send and why.
 *
 * E-Blasts go out through the Resend BROADCASTS API (`broadcasts.create` +
 * send): one HTML body per audience, created before any recipient is known.
 * That API has no `headers` field (resend@4.8.0 `CreateBroadcastOptions` is
 * name/audienceId/from/replyTo/subject/previewText/html/text, and the SDK
 * builds the request body from that fixed list), so our own signed
 * `List-Unsubscribe` / `List-Unsubscribe-Post` headers CANNOT be attached.
 * Per-recipient `emails.send` is ruled out by FR-019 (it would move
 * marketing mail onto the transactional reputation pool).
 *
 * What covers one-click instead: Resend adds its own List-Unsubscribe +
 * List-Unsubscribe-Post headers to every broadcast, pointing at its hosted
 * endpoint, and the body link is the `{{{RESEND_UNSUBSCRIBE_URL}}}` merge
 * tag. Both flip the Resend contact, which arrives as `contact.updated` and
 * is mirrored tenant-wide into `marketing_unsubscribes` by the webhook route
 * (channel `resend_hosted`). The runbook step "verify List-Unsubscribe on a
 * test broadcast" checks the Resend-side headers on a real send.
 *
 * Our own signed header (`buildListUnsubscribeHeaders`) stays ready for a
 * per-recipient send path: it points at `/unsubscribe/<token>`, which now
 * answers the one-click POST.
 */
import { describe, expect, it, vi } from 'vitest';
import { createResendContractFake } from '../../../support/broadcasts/resend-contract-fake';

const fake = createResendContractFake();
vi.mock('@/modules/broadcasts/infrastructure/resend/resend-broadcasts-client', () => ({
  getResendBroadcastsClient: () => fake.client,
}));

import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';
import { buildListUnsubscribeHeaders } from '@/modules/broadcasts/infrastructure/resend/email-template';
import { unsubscribeTokenSigner } from '@/modules/broadcasts/infrastructure/unsubscribe-token/hmac-signer';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { unsafeBrandTenantSlug } from '@/modules/tenants';

// The request fields the Resend Broadcasts create endpoint accepts.
const BROADCASTS_CREATE_FIELDS = new Set([
  'name',
  'audienceId',
  'from',
  'replyTo',
  'subject',
  'previewText',
  'html',
  'text',
]);

describe('E-Blast List-Unsubscribe', () => {
  it('broadcasts.create carries no custom headers (the API has none) — unsubscribe rides Resend’s merge tag', async () => {
    const createSpy = vi.spyOn(fake.client.broadcasts, 'create');
    await resendBroadcastsGateway.createBroadcast({
      audienceId: 'aud_fake_1',
      subject: 'Hi',
      htmlBody: '<p>hi</p>',
      fromName: 'SweCham',
      fromEmail: 'noreply@zyncdata.app',
      replyToEmail: 'noreply@zyncdata.app',
      broadcastNameForResendDashboard: 'SweCham — Hi',
      tenantDisplayName: 'SweCham',
      locale: 'en',
    });
    const args = createSpy.mock.calls[0]![0] as Record<string, unknown>;
    for (const key of Object.keys(args)) expect(BROADCASTS_CREATE_FIELDS).toContain(key);
    expect(args).not.toHaveProperty('headers');
    expect(String(args['html'])).toContain('href="{{{RESEND_UNSUBSCRIBE_URL}}}"');
  });

  it('our signed header points at /unsubscribe/<token> (which answers the one-click POST)', () => {
    const headers = buildListUnsubscribeHeaders({
      tenantId: unsafeBrandTenantSlug('swecham'),
      broadcastId: asBroadcastId('11111111-1111-1111-1111-111111111111'),
      emailLower: unsafeBrandEmailLower('alice@example.com'),
      tenantHost: 'members.swecham.com',
      locale: 'sv',
    });
    expect(headers.listUnsubscribePost).toBe('List-Unsubscribe=One-Click');
    const m = /^<https:\/\/members\.swecham\.com\/unsubscribe\/([^?>]+)\?lang=sv>$/.exec(
      headers.listUnsubscribe,
    );
    expect(m).not.toBeNull();
    const verified = unsubscribeTokenSigner.verify(decodeURIComponent(m![1]!));
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.value.tenantId).toBe('swecham');
      expect(verified.value.emailLower).toBe('alice@example.com');
    }
  });
});
