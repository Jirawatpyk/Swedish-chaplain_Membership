import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { BrandHexColor } from '@/modules/broadcasts/domain/brand/brand-settings';
import { createResendContractFake } from '../../../support/broadcasts/resend-contract-fake';

const fake = createResendContractFake();
vi.mock('@/modules/broadcasts/infrastructure/resend/resend-broadcasts-client', () => ({
  getResendBroadcastsClient: () => fake.client,
}));

import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';
import { stripAngleBrackets } from '@/modules/broadcasts/infrastructure/resend/bare-email';

// Minimal valid createBroadcast input; individual tests override `name`/`fromName`.
function input(over: Partial<Parameters<typeof resendBroadcastsGateway.createBroadcast>[0]>) {
  return {
    audienceId: 'aud_fake_1',
    subject: 'Hi',
    htmlBody: '<p>hi</p>',
    fromName: 'SweCham',
    fromEmail: 'noreply@zyncdata.app',
    replyToEmail: 'noreply@zyncdata.app',
    broadcastNameForResendDashboard: 'SweCham — Hi',
    tenantDisplayName: 'SweCham',
    locale: 'en' as const,
    ...over,
  };
}

describe('resendBroadcastsGateway.createBroadcast — Resend contract', () => {
  beforeEach(() => vi.clearAllMocks());

  // F119 T031 — the live send carries the tenant's brand chrome (FR-041a/c):
  // the delivered email must equal the preview, which renders with it.
  it('renders the brand passed in — logo header, postal footer, CTA colour — into the html handed to Resend', async () => {
    await resendBroadcastsGateway.createBroadcast(
      input({
        htmlBody: '<p>hi</p><a data-eb="cta" href="https://x.example/">Go</a>',
        brand: { primaryColor: '#b04a00' as BrandHexColor, postalAddress: '1 Street', logoUrl: 'https://blob.example/l.png' },
      }),
    );
    const html = fake.lastCreatedBroadcastHtml();
    expect(html).not.toBeNull();
    expect(html).toContain('src="https://blob.example/l.png"');
    expect(html).toContain('<p style="margin:0">1 Street</p>');
    expect(html).toContain('bgcolor="#b04a00"');
    expect(html).not.toContain('data-eb="cta"');
  });

  it('with no brand (the pre-F119 caller shape) the html is the chamber-name header, as before', async () => {
    await resendBroadcastsGateway.createBroadcast(input({}));
    const html = fake.lastCreatedBroadcastHtml();
    expect(html).toContain('<strong style="font-size:14px;color:#666">SweCham</strong>');
    expect(html).toContain('Sent by SweCham.');
  });

  it('accepts a <=70-code-point name', async () => {
    await expect(resendBroadcastsGateway.createBroadcast(input({}))).resolves.toMatchObject({ broadcastId: 'bcast_fake_1' });
  });

  it('rejects a >70-code-point name (the #2 regression guard)', async () => {
    const longName = 'x'.repeat(71);
    await expect(resendBroadcastsGateway.createBroadcast(input({ broadcastNameForResendDashboard: longName }))).rejects.toThrow();
  });

  it('composes a single-wrapped from when fromEmail is bare', async () => {
    await expect(resendBroadcastsGateway.createBroadcast(input({ fromName: 'E2E Alpha Co via TSCC', fromEmail: 'noreply@zyncdata.app' }))).resolves.toMatchObject({ broadcastId: 'bcast_fake_1' });
  });

  it('does NOT double-wrap when fromEmail is "Name <email>" (the #3 regression guard)', async () => {
    // Before the fix this produced `… <SweCham <noreply@…>>` and the fake (like
    // real Resend) rejects the nested `<>`.
    await expect(resendBroadcastsGateway.createBroadcast(input({ fromName: 'E2E Alpha Co via TSCC', fromEmail: 'SweCham <noreply@zyncdata.app>' }))).resolves.toMatchObject({ broadcastId: 'bcast_fake_1' });
  });

  it('strips angle brackets from fromName so a `<Acme>` company name yields a valid `from` (Finding B)', async () => {
    // `composeBroadcastFromName` interpolates the member company name raw. A
    // name with `<`/`>` (e.g. `<Acme> via SweCham`) previously produced
    // `from: "<Acme> via SweCham <noreply@…>"` — an invalid RFC 5322 address
    // the contract-fake (like real Resend) now rejects. After stripping, the
    // `from` is `Acme via SweCham <noreply@…>` and the create succeeds.
    await expect(
      resendBroadcastsGateway.createBroadcast(
        input({ fromName: '<Acme> via SweCham', fromEmail: 'noreply@zyncdata.app' }),
      ),
    ).resolves.toMatchObject({ broadcastId: 'bcast_fake_1' });
  });

  it('stripAngleBrackets removes < and > and collapses whitespace (direct)', () => {
    expect(stripAngleBrackets('<Acme> via SweCham')).toBe('Acme via SweCham');
    expect(stripAngleBrackets('Acme> <Corp via TSCC')).toBe('Acme Corp via TSCC');
    expect(stripAngleBrackets('  Plain Name  ')).toBe('Plain Name');
    expect(stripAngleBrackets('No brackets here')).toBe('No brackets here');
  });
});

/**
 * `POST /broadcasts` on a DELETED audience answers `404 {name:"not_found",
 * message:"Audience not found"}` (MEASURED 2026-10-29). Pinned UNCHANGED: with
 * no resource id passed, a 404 classifies `permanent` with `code: 'not_found'`
 * — never `resource_missing`. The dispatch tick (at its own call site) reads
 * exactly this shape as "the audience is gone" and restarts the build. (The
 * legacy leg, which kept a permanent arm for it, was deleted in spec 140 s4.)
 */
describe('resendBroadcastsGateway.createBroadcast — a 404 on a deleted audience', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is permanent with code not_found and no resource id (the classification, unchanged)', async () => {
    vi.spyOn(fake.client.broadcasts, 'create').mockResolvedValue({
      data: null,
      error: { statusCode: 404, message: 'Audience not found', name: 'not_found' },
    } as Awaited<ReturnType<typeof fake.client.broadcasts.create>>);

    const thrown = await resendBroadcastsGateway.createBroadcast(input({})).catch((e: unknown) => e);

    expect(thrown).toMatchObject({ kind: 'permanent', code: 'not_found' });
    expect((thrown as { resourceId?: unknown }).resourceId).toBeUndefined();
  });
});

describe('resendBroadcastsGateway.listAudiences — Resend contract', () => {
  it('maps created_at→createdAt and returns only live audiences after create×2 then remove×1', async () => {
    // The module-level `fake` is already wired into the gateway via the
    // top-of-file vi.mock — calling resendBroadcastsGateway.listAudiences()
    // goes through the REAL gateway impl (create→send→list mapping logic)
    // against the in-memory fake, never hitting real Resend.
    //
    // The createBroadcast describe-block above does not call segments.create,
    // so the fake's audience counter is still 0 here.
    const r1 = await fake.client.segments.create({ name: 'Audience Alpha' });
    const r2 = await fake.client.segments.create({ name: 'Audience Beta' });
    expect(r1.data?.id).toBe('aud_fake_1');
    expect(r2.data?.id).toBe('aud_fake_2');

    // Remove the first one.
    await fake.client.segments.remove('aud_fake_1');

    // Drive the REAL gateway method — this is the point of this test.
    // If the gateway mis-reads result.data instead of result.data.data, or
    // forgets to map created_at→createdAt, this assertion fails.
    const { audiences, truncated } = await resendBroadcastsGateway.listAudiences({
      deadlineAt: new Date(Date.now() + 60_000),
    });
    expect(truncated).toBe(false);

    expect(audiences).toHaveLength(1);
    expect(audiences[0]).toMatchObject({ id: 'aud_fake_2', name: 'Audience Beta' });
    // Proves the gateway maps snake_case created_at → camelCase createdAt (as Date).
    expect(audiences[0]?.createdAt).toBeInstanceOf(Date);
  });
});
