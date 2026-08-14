import { describe, expect, it } from 'vitest';
import {
  asUserId,
  asSessionToken,
  asTokenId,
  asAuditEventId,
  asEmailRevertTokenHash,
  asEmailVerificationTokenHash,
  asInvitationTokenHash,
  asInvitationTokenId,
  asPasswordHash,
  asEmailAddress,
} from '@/modules/auth/domain/branded';

describe('Branded type constructors', () => {
  it('asUserId returns the input string', () => {
    const id = asUserId('abc-123');
    expect(id).toBe('abc-123');
  });

  it('asSessionToken returns the input string', () => {
    expect(asSessionToken('sess-1')).toBe('sess-1');
  });

  it('asTokenId returns the input string', () => {
    expect(asTokenId('tok-1')).toBe('tok-1');
  });

  it('asAuditEventId returns the input string', () => {
    expect(asAuditEventId('evt-1')).toBe('evt-1');
  });

  it('asPasswordHash returns the input string', () => {
    expect(asPasswordHash('$argon2id$...')).toBe('$argon2id$...');
  });

  it('the F3 email-change hash constructors are pure casts (016 T072 coverage closure)', () => {
    expect(asEmailVerificationTokenHash('a'.repeat(64))).toBe('a'.repeat(64));
    expect(asEmailRevertTokenHash('b'.repeat(64))).toBe('b'.repeat(64));
  });

  it('the invitation-token constructors are pure casts (full-run coverage truth: the table truncated these from the left)', () => {
    expect(asInvitationTokenId('c'.repeat(64))).toBe('c'.repeat(64));
    expect(asInvitationTokenHash('d'.repeat(64))).toBe('d'.repeat(64));
  });
});

describe('asEmailAddress', () => {
  it('normalises to lowercase + trimmed', () => {
    expect(asEmailAddress('  Admin@SweCham.com  ')).toBe('admin@swecham.com');
  });

  it('accepts a minimal valid email', () => {
    expect(asEmailAddress('a@b')).toBe('a@b');
  });

  it('throws on an email without @', () => {
    expect(() => asEmailAddress('notanemail')).toThrow('Invalid email');
  });

  it('throws on a string shorter than 3 chars', () => {
    expect(() => asEmailAddress('a@')).toThrow('Invalid email');
  });

  it('throws on empty string', () => {
    expect(() => asEmailAddress('')).toThrow('Invalid email');
  });
});
