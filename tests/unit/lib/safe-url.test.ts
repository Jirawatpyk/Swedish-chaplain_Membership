/**
 * Unit test: URL-scheme safety helpers (branch 066 — website stored-XSS fix).
 *
 * Guards the `<a href>` sinks on the member-detail + portal-profile pages
 * against `javascript:`/`data:` schemes that zod's `.url()` lets through.
 */
import { describe, expect, it } from 'vitest';
import { isHttpUrl, hasDangerousUrlScheme, safeExternalHref } from '@/lib/safe-url';

describe('isHttpUrl', () => {
  it('accepts absolute http(s) URLs (case- and whitespace-tolerant)', () => {
    for (const ok of [
      'http://example.com',
      'https://example.com/path?q=1',
      'HTTPS://EXAMPLE.COM',
      '  https://example.com  ',
    ]) {
      expect(isHttpUrl(ok)).toBe(true);
    }
  });

  it('rejects dangerous, scheme-less, and non-http schemes', () => {
    for (const no of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'example.com',
      '//evil.com',
      'ftp://example.com',
      'mailto:x@y.com',
      '',
    ]) {
      expect(isHttpUrl(no)).toBe(false);
    }
  });
});

describe('hasDangerousUrlScheme', () => {
  it('flags javascript/data/vbscript/file, incl. leading space + mixed case', () => {
    for (const bad of [
      'javascript:alert(1)',
      '  JavaScript:alert(1)',
      'data:text/html,x',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) {
      expect(hasDangerousUrlScheme(bad)).toBe(true);
    }
  });

  it('does not flag http(s) or scheme-less input', () => {
    for (const okv of ['https://example.com', 'http://x', 'example.com', 'www.example.com', '']) {
      expect(hasDangerousUrlScheme(okv)).toBe(false);
    }
  });
});

describe('safeExternalHref', () => {
  it('returns the url for safe absolute http(s) links', () => {
    expect(safeExternalHref('https://example.com')).toBe('https://example.com');
    expect(safeExternalHref('  http://x.io/p  ')).toBe('http://x.io/p');
  });

  it('returns undefined for dangerous, scheme-less, empty, or null values', () => {
    for (const no of [
      'javascript:alert(document.cookie)',
      'data:text/html,<script>',
      'example.com',
      '//evil.com',
      '',
      null,
      undefined,
    ]) {
      expect(safeExternalHref(no)).toBeUndefined();
    }
  });
});
