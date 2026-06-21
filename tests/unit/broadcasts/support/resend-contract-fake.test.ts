// tests/unit/broadcasts/support/resend-contract-fake.test.ts
//
// Direct pin-tests for the Resend contract-faithful fake.
// The fake is load-bearing infrastructure used by gateway-contract tests; its
// enforcement rules must be pinned so a refactor can't silently weaken them.

import { describe, it, expect } from 'vitest';
import { createResendContractFake } from '../../../support/broadcasts/resend-contract-fake';

/** Minimal valid args for broadcasts.create, with overrideable fields. */
const baseCreateArgs = {
  audienceId: 'aud_test',
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
});

describe('createResendContractFake › audiences.create with audienceLimit', () => {
  it('allows the first call and rejects the second when limit is 1', async () => {
    const { client, createdAudienceCount } = createResendContractFake({ audienceLimit: 1 });

    const first = await client.audiences.create({ name: 'audience-a' });
    expect(first.error).toBeNull();
    expect(first.data?.id).toBeDefined();
    expect(createdAudienceCount()).toBe(1);

    const second = await client.audiences.create({ name: 'audience-b' });
    expect(second.data).toBeNull();
    expect(second.error).not.toBeNull();
    expect(second.error?.message).toContain('segments');
    expect(createdAudienceCount()).toBe(1); // count must not increment on rejection
  });

  it('error message does not render "Infinity segments" when limit is default (Infinity)', async () => {
    // If audienceLimit stays at Infinity (no opts passed), the error message
    // must use the fallback label '3' rather than "Infinity".
    const { client } = createResendContractFake({ audienceLimit: 0 }); // 0 = immediately limited
    const result = await client.audiences.create({ name: 'any' });
    expect(result.error?.message).not.toContain('Infinity');
    expect(result.error?.message).toContain('segments');
  });
});

describe('createResendContractFake › audiences.remove', () => {
  it('succeeds when removing a previously-created audience', async () => {
    const { client } = createResendContractFake();
    const created = await client.audiences.create({ name: 'my-audience' });
    const audienceId = created.data?.id ?? '';

    const removed = await client.audiences.remove(audienceId);
    expect(removed.error).toBeNull();
    expect(removed.data?.deleted).toBe(true);
    expect(removed.data?.id).toBe(audienceId);
  });

  it('returns 404 when removing an unknown audience (idempotent double-delete)', async () => {
    const { client } = createResendContractFake();
    const created = await client.audiences.create({ name: 'ephemeral' });
    const audienceId = created.data?.id ?? '';

    // First remove: succeeds
    const first = await client.audiences.remove(audienceId);
    expect(first.error).toBeNull();

    // Second remove: 404 (already gone) — matches Resend API behaviour
    const second = await client.audiences.remove(audienceId);
    expect(second.data).toBeNull();
    expect(second.error?.statusCode).toBe(404);
  });

  it('returns 404 for an audience that was never created', async () => {
    const { client } = createResendContractFake();
    const result = await client.audiences.remove('aud_nonexistent');
    expect(result.data).toBeNull();
    expect(result.error?.statusCode).toBe(404);
  });
});
