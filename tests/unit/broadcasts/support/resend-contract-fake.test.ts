// tests/unit/broadcasts/support/resend-contract-fake.test.ts
//
// Direct pin-tests for the Resend contract-faithful fake.
// The fake is load-bearing infrastructure used by gateway-contract tests; its
// enforcement rules must be pinned so a refactor can't silently weaken them.

import { describe, it, expect } from 'vitest';
import { createResendContractFake } from '../../../support/broadcasts/resend-contract-fake';

/** Minimal valid args for broadcasts.create, with overrideable fields. */
const baseCreateArgs = {
  segmentId: 'aud_test',
  subject: 'Test subject',
  html: '<p>Hello</p>',
  replyTo: 'no-reply@example.com',
  from: 'SweCham <noreply@zyncdata.app>',
  name: 'Test broadcast',
};

describe('createResendContractFake › broadcasts.create', () => {
  it('rejects a name longer than 70 code-points', async () => {
    const { client } = createResendContractFake();
    const result = await client.broadcasts.create({
      ...baseCreateArgs,
      name: 'x'.repeat(71),
    });
    expect(result.data).toBeNull();
    expect(result.error).not.toBeNull();
    expect(result.error?.name).toBe('validation_error');
  });

  it('accepts a name of exactly 70 code-points', async () => {
    const { client } = createResendContractFake();
    const result = await client.broadcasts.create({
      ...baseCreateArgs,
      name: 'x'.repeat(70),
    });
    expect(result.error).toBeNull();
    expect(result.data?.id).toBeDefined();
  });

  it('accepts a plain `Name <local@domain>` from address', async () => {
    const { client } = createResendContractFake();
    const result = await client.broadcasts.create({
      ...baseCreateArgs,
      from: 'SweCham <noreply@zyncdata.app>',
    });
    expect(result.error).toBeNull();
    expect(result.data?.id).toBeDefined();
  });

  it('rejects the double-wrapped from address (regression #3)', async () => {
    // "E2E Alpha Co via TSCC <SweCham <noreply@zyncdata.app>>" must be rejected
    // exactly as Resend would reject it, ensuring gateway code that builds this
    // shape is caught by the fake before ever reaching the real API.
    const { client } = createResendContractFake();
    const result = await client.broadcasts.create({
      ...baseCreateArgs,
      from: 'E2E Alpha Co via TSCC <SweCham <noreply@zyncdata.app>>',
    });
    expect(result.data).toBeNull();
    expect(result.error).not.toBeNull();
    expect(result.error?.name).toBe('validation_error');
  });

  it('rejects angle brackets in the display-name part (Finding B)', async () => {
    // `<Acme> via SweCham <noreply@…>` — the trailing address is valid, but
    // the unquoted `<`/`>` in the display name is not RFC 5322 and real Resend
    // rejects it. The fake must too, so a gateway that interpolates an
    // un-sanitised `${fromName}` is caught here.
    const { client } = createResendContractFake();
    const result = await client.broadcasts.create({
      ...baseCreateArgs,
      from: '<Acme> via SweCham <noreply@zyncdata.app>',
    });
    expect(result.data).toBeNull();
    expect(result.error).not.toBeNull();
    expect(result.error?.name).toBe('validation_error');
  });

  it('still accepts a clean display name with the same trailing address (Finding B — no false positive)', async () => {
    const { client } = createResendContractFake();
    const result = await client.broadcasts.create({
      ...baseCreateArgs,
      from: 'Acme via SweCham <noreply@zyncdata.app>',
    });
    expect(result.error).toBeNull();
    expect(result.data?.id).toBeDefined();
  });
});

describe('createResendContractFake › segments.create with audienceLimit', () => {
  it('allows the first call and rejects the second when limit is 1', async () => {
    const { client, createdAudienceCount } = createResendContractFake({ audienceLimit: 1 });

    const first = await client.segments.create({ name: 'audience-a' });
    expect(first.error).toBeNull();
    expect(first.data?.id).toBeDefined();
    expect(createdAudienceCount()).toBe(1);

    const second = await client.segments.create({ name: 'audience-b' });
    expect(second.data).toBeNull();
    expect(second.error).not.toBeNull();
    expect(second.error?.message).toContain('segments');
    expect(createdAudienceCount()).toBe(1); // count must not increment on rejection
  });

  it('error message does not render "Infinity segments" when limit is default (Infinity)', async () => {
    // If audienceLimit stays at Infinity (no opts passed), the error message
    // must use the fallback label '3' rather than "Infinity".
    const { client } = createResendContractFake({ audienceLimit: 0 }); // 0 = immediately limited
    const result = await client.segments.create({ name: 'any' });
    expect(result.error?.message).not.toContain('Infinity');
    expect(result.error?.message).toContain('segments');
  });
});

describe('createResendContractFake › segments.remove', () => {
  it('succeeds when removing a previously-created audience', async () => {
    const { client } = createResendContractFake();
    const created = await client.segments.create({ name: 'my-audience' });
    const audienceId = created.data?.id ?? '';

    const removed = await client.segments.remove(audienceId);
    expect(removed.error).toBeNull();
    expect(removed.data?.deleted).toBe(true);
    expect(removed.data?.id).toBe(audienceId);
  });

  it('returns 404 when removing an unknown audience (idempotent double-delete)', async () => {
    const { client } = createResendContractFake();
    const created = await client.segments.create({ name: 'ephemeral' });
    const audienceId = created.data?.id ?? '';

    // First remove: succeeds
    const first = await client.segments.remove(audienceId);
    expect(first.error).toBeNull();

    // Second remove: 404 (already gone) — matches Resend API behaviour
    const second = await client.segments.remove(audienceId);
    expect(second.data).toBeNull();
    expect(second.error?.statusCode).toBe(404);
  });

  it('returns 404 for an audience that was never created', async () => {
    const { client } = createResendContractFake();
    const result = await client.segments.remove('aud_nonexistent');
    expect(result.data).toBeNull();
    expect(result.error?.statusCode).toBe(404);
  });
});

// Spec 140 s4 — the detach is `contacts.segments.remove({ email, segmentId })`,
// answered as MEASURED on 5 Nov 2026 (research.md slice 4 step 0 item 1).
describe('createResendContractFake › contacts.segments.remove', () => {
  // Spec 140 DR4 — the id-less `contacts.remove` is the account-wide
  // `DELETE /contacts/{email}`; the fake refuses it instead of answering success,
  // and RECORDS it (PR #756 review round 1, security L2): the gateway's
  // `boundedCall` turns a throw that is not a `GatewayThrowable` into a
  // retryable, so the throw alone could vanish inside the code under test.
  it('contacts.remove (the account-wide delete) throws and is recorded in forbiddenCalls', async () => {
    const { client, forbiddenCalls } = createResendContractFake({ forbiddenCallsFailTest: false });
    await expect(client.contacts.remove({ email: 'a@example.com' })).rejects.toThrow(/account-wide/);
    expect(forbiddenCalls).toEqual([{ method: 'contacts.remove', args: [{ email: 'a@example.com' }] }]);
  });

  // The default fake fails the test a forbidden call happened in, from
  // `onTestFinished`, even when the throw was swallowed: the body below catches
  // it and asserts nothing, so `it.fails` passes only if the fake failed it.
  it.fails('by default a swallowed contacts.remove still fails the test it ran in', async () => {
    const { client } = createResendContractFake();
    await client.contacts.remove({ email: 'a@example.com' }).catch(() => undefined);
  });

  it('a fake that saw no forbidden call leaves forbiddenCalls empty', async () => {
    const { client, forbiddenCalls } = createResendContractFake();
    await client.contacts.segments.remove({ email: 'a@example.com', segmentId: 'aud_unknown' });
    expect(forbiddenCalls).toEqual([]);
  });

  it('answers 200 contact_segment deleted:true by default', async () => {
    const { client } = createResendContractFake();
    const result = await client.contacts.segments.remove({ email: 'a@example.com', segmentId: 'aud_unknown' });
    expect(result).toEqual({ data: { object: 'contact_segment', deleted: true }, error: null });
  });

  it('with detach404OnUnknownSegment, answers 404 for a segment it never created or has removed', async () => {
    const { client } = createResendContractFake({ detach404OnUnknownSegment: true });
    const never = await client.contacts.segments.remove({ email: 'a@example.com', segmentId: 'aud_unknown' });
    expect(never.data).toBeNull();
    expect(never.error?.statusCode).toBe(404);

    const created = await client.segments.create({ name: 'live' });
    const segmentId = created.data?.id ?? '';
    const live = await client.contacts.segments.remove({ email: 'a@example.com', segmentId });
    expect(live.error).toBeNull();
    expect(live.data?.deleted).toBe(true);

    await client.segments.remove(segmentId);
    const removed = await client.contacts.segments.remove({ email: 'a@example.com', segmentId });
    expect(removed.error?.statusCode).toBe(404);
  });
});
