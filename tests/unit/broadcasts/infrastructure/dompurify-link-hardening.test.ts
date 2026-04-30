/**
 * F7.1-T1 — Link-hardening hook regression test.
 *
 * The `dompurifySanitizer` adapter installs an `afterSanitizeAttributes`
 * hook on first call that forces every surviving `<a>` to carry
 * `rel="noopener noreferrer nofollow"` + `target="_blank"`. This is a
 * security control on member-authored HTML reaching recipient inboxes
 * (reverse-tabnabbing + clickjacking + SEO-pollution mitigation;
 * OWASP A03 — broken-by-default linking).
 *
 * Round-3 added the hook; F7.1-T1 pins the behaviour so a future
 * DOMPurify upgrade or refactor cannot silently drop it.
 */
import { describe, expect, it } from 'vitest';
import { dompurifySanitizer } from '@/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer';

describe('dompurifySanitizer link-hardening hook', () => {
  it('adds rel="noopener noreferrer nofollow" to <a href="https://…">', () => {
    const out = dompurifySanitizer.sanitize(
      '<a href="https://example.com">link</a>',
    );
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it('adds target="_blank" to <a href="https://…">', () => {
    const out = dompurifySanitizer.sanitize(
      '<a href="https://example.com">link</a>',
    );
    expect(out).toContain('target="_blank"');
  });

  it('overwrites attacker-supplied rel="opener"', () => {
    const out = dompurifySanitizer.sanitize(
      '<a href="https://example.com" rel="opener">link</a>',
    );
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).not.toContain('rel="opener"');
  });

  it('overwrites attacker-supplied target="_self"', () => {
    const out = dompurifySanitizer.sanitize(
      '<a href="https://example.com" target="_self">link</a>',
    );
    expect(out).toContain('target="_blank"');
    expect(out).not.toContain('target="_self"');
  });

  it('hardens mailto: links the same way', () => {
    const out = dompurifySanitizer.sanitize(
      '<a href="mailto:hi@example.com">contact</a>',
    );
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
  });

  it('strips javascript: scheme entirely (allowed-uri-regexp)', () => {
    const out = dompurifySanitizer.sanitize(
      '<a href="javascript:alert(1)">link</a>',
    );
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('alert(1)');
  });

  it('strips data: scheme entirely', () => {
    const out = dompurifySanitizer.sanitize(
      '<a href="data:text/html,<script>x</script>">link</a>',
    );
    expect(out).not.toContain('data:');
  });

  it('hook is idempotent — calling sanitize repeatedly does not stack rel values', () => {
    // Multiple sanitize calls must produce the same `rel` attribute,
    // not e.g. `rel="noopener noreferrer nofollow noopener noreferrer nofollow"`.
    const input = '<a href="https://example.com">link</a>';
    const out1 = dompurifySanitizer.sanitize(input);
    const out2 = dompurifySanitizer.sanitize(input);
    expect(out1).toBe(out2);
    // exactly one `rel="..."` attribute
    const relMatches = out1.match(/rel="[^"]+"/g) ?? [];
    expect(relMatches.length).toBe(1);
  });

  it('does NOT add rel/target to non-anchor tags', () => {
    const out = dompurifySanitizer.sanitize('<p>plain paragraph</p>');
    expect(out).not.toContain('rel=');
    expect(out).not.toContain('target=');
  });

  it('preserves the visible link text', () => {
    const out = dompurifySanitizer.sanitize(
      '<a href="https://example.com">click here</a>',
    );
    expect(out).toContain('click here');
  });
});
