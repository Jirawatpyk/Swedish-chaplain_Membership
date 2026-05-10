/**
 * F8 R11 coverage closure — `sanitizeResendErrorMessage` defence-in-depth
 * sanitiser tests. Lineage: K13-3 / K15 / R13-S4 / R14-S2 review rounds.
 *
 * Strategy under test:
 *   1. Strip Resend API-key prefixes (`re_xxxxxxxxxxxx`)
 *   2. Strip email addresses (RFC-light pattern)
 *   3. Strip domain-like tokens over closed TLD allowlist
 *   4. Truncate to 100 chars + trim
 */
import { describe, expect, it } from 'vitest';
import { sanitizeResendErrorMessage } from '@/modules/renewals/domain/value-objects/sanitize-error-message';

describe('sanitizeResendErrorMessage — strip Resend API key', () => {
  it('replaces re_xxxxxxxxxxxx prefix with [REDACTED_KEY]', () => {
    const out = sanitizeResendErrorMessage('Auth failed for re_abcd1234efgh5678 token');
    expect(out).toContain('[REDACTED_KEY]');
    expect(out).not.toContain('re_abcd');
  });

  it('does NOT redact short re_ prefix that lacks 8+ key chars (false-positive guard)', () => {
    const out = sanitizeResendErrorMessage('re_x is too short');
    expect(out).toContain('re_x'); // 8-char minimum not met
  });
});

describe('sanitizeResendErrorMessage — strip email address', () => {
  it('replaces email with [REDACTED_EMAIL]', () => {
    const out = sanitizeResendErrorMessage('Failed to deliver to alice@example.com');
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).not.toContain('alice@example.com');
  });

  it('replaces email with sub-addressing + uncommon TLD', () => {
    const out = sanitizeResendErrorMessage(
      'rejected: bob.smith+spam@a-b.org from upstream',
    );
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).not.toContain('bob.smith');
  });
});

describe('sanitizeResendErrorMessage — strip domain over closed TLD allowlist', () => {
  it.each([
    ['com', 'swecham.com'],
    ['net', 'mail.net'],
    ['org', 'foo.org'],
    ['io', 'app.io'],
    ['co', 'biz.co'],
    ['app', 'zyncdata.app'],
    ['dev', 'foo.dev'],
    ['se', 'svenska.se'],
    ['th', 'thai.th'],
    ['au', 'aus.au'],
    ['uk', 'london.uk'],
    ['de', 'berlin.de'],
    ['nl', 'amsterdam.nl'],
    ['fr', 'paris.fr'],
    ['es', 'madrid.es'],
    ['it', 'rome.it'],
    ['ch', 'zurich.ch'],
    ['be', 'brussels.be'],
    ['dk', 'copenhagen.dk'],
    ['fi', 'helsinki.fi'],
    ['gov', 'usa.gov'],
    ['edu', 'mit.edu'],
  ] as const)('redacts %s TLD domain (%s)', (_tld, domain) => {
    const out = sanitizeResendErrorMessage(`Connection refused: ${domain} timed out`);
    expect(out).toContain('[REDACTED_DOMAIN]');
    expect(out).not.toContain(domain);
  });

  it('redacts multi-label hostname whole — K14-7 R13-S4 fix', () => {
    const out = sanitizeResendErrorMessage('Could not reach swecham.zyncdata.app for delivery');
    expect(out).toContain('[REDACTED_DOMAIN]');
    expect(out).not.toContain('swecham');
    expect(out).not.toContain('zyncdata');
  });

  it('does NOT redact domain with TLD outside the allowlist (K15-5 accepted residual)', () => {
    const out = sanitizeResendErrorMessage('Connection refused: example.xyz timed out');
    expect(out).toContain('example.xyz');
    expect(out).not.toContain('[REDACTED_DOMAIN]');
  });
});

describe('sanitizeResendErrorMessage — length cap (K15-3)', () => {
  it('truncates output to ≤100 chars', () => {
    const long = 'a'.repeat(500);
    const out = sanitizeResendErrorMessage(long);
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it('trims trailing whitespace after truncation', () => {
    const padded = 'short message'.padEnd(150, ' ');
    const out = sanitizeResendErrorMessage(padded);
    expect(out).toBe('short message');
    expect(out.endsWith(' ')).toBe(false);
  });
});

describe('sanitizeResendErrorMessage — composite (K15 happy path)', () => {
  it('strips all 3 PII classes in a single message', () => {
    const out = sanitizeResendErrorMessage(
      'Auth re_abcd1234efgh5678 failed for alice@swecham.com via swecham.com endpoint',
    );
    expect(out).toContain('[REDACTED_KEY]');
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).toContain('[REDACTED_DOMAIN]');
    expect(out).not.toContain('alice');
    expect(out).not.toContain('re_abcd');
  });
});
