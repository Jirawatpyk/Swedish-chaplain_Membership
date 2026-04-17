import { describe, expect, it } from 'vitest';
import {
  asUserId,
  asSessionId,
  asTokenId,
  asAuditEventId,
  asPasswordHash,
  asEmailAddress,
} from '@/modules/auth/domain/branded';

describe('Branded type constructors', () => {
  it('asUserId returns the input string', () => {
    const id = asUserId('abc-123');
    expect(id).toBe('abc-123');
  });

  it('asSessionId returns the input string', () => {
    expect(asSessionId('sess-1')).toBe('sess-1');
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
