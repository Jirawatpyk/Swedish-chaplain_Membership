/**
 * T042 — Unit tests for `sanitize-html.ts` Application use-case.
 *
 * Authored ahead of T064 implementation per Constitution Principle II
 * TDD discipline. Wave 6 fills the bodies — exercises every FR-002a
 * allowlist branch + 200 KB cap + determinism + empty/edge cases.
 *
 * Use-case shape: `sanitizeHtml({ sanitizer }, { rawHtml }) → Result<{sanitisedHtml, bytes}, error>`.
 * The Application layer wraps the sanitiser port; we inject the real
 * DOMPurify adapter so these tests verify the full pipeline (Application
 * + Infrastructure) — there is no mocking value when the entire purpose
 * of the use-case is "wire DOMPurify with the right config".
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sanitizeHtml } from '@/modules/broadcasts';
import { dompurifySanitizer } from '@/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/sanitize-html.ts',
);

const deps = { sanitizer: dompurifySanitizer };

// The strict <200ms wall-clock budget is gated behind RUN_PERF=1 (repo
// convention, cf. tests/integration/**/*-perf.test.ts). Under full-suite load
// (600+ files + background tasks) the absolute timer measures host contention,
// not a sanitiser regression — it flakes at ~314ms while passing in isolation
// (B0-U1). The functional assertion (200KB input handled within a coarse
// load-tolerant ceiling — NOT a targeted ReDoS probe; see the in-test note) runs
// every time; only the precise budget is asserted in the dedicated perf lane.
const RUN_PERF = process.env.RUN_PERF === '1';

function sanitize(rawHtml: string): string {
  const result = sanitizeHtml(deps, { rawHtml });
  if (!result.ok) {
    throw new Error(
      `expected success but got error: ${JSON.stringify(result.error)}`,
    );
  }
  return result.value.sanitisedHtml;
}

describe('sanitize-html — Wave 6 (T064 GREEN)', () => {
  it('use-case module exists at application/use-cases/sanitize-html.ts', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // ---- Passthrough — FR-002a allowed tags ---------------------------

  it('passthrough <p>: paragraph tag preserved', () => {
    expect(sanitize('<p>Hello</p>')).toContain('<p>Hello</p>');
  });

  it('passthrough <br>: line break preserved', () => {
    expect(sanitize('Line one<br>Line two')).toMatch(/<br\s*\/?>/);
  });

  it('passthrough <strong>, <em>, <u>: text-formatting tags preserved', () => {
    const out = sanitize('<p><strong>bold</strong> <em>italic</em> <u>under</u></p>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain('<u>under</u>');
  });

  it('passthrough <a href="https://...">: link with allowed scheme', () => {
    const out = sanitize('<a href="https://example.com">link</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('>link</a>');
  });

  it('passthrough <a href="mailto:...">: mailto scheme allowed', () => {
    const out = sanitize('<a href="mailto:hello@example.com">email</a>');
    expect(out).toContain('href="mailto:hello@example.com"');
  });

  it('passthrough <ul>, <ol>, <li>: list tags preserved', () => {
    const ul = sanitize('<ul><li>a</li><li>b</li></ul>');
    expect(ul).toContain('<ul>');
    expect(ul).toContain('<li>a</li>');
    const ol = sanitize('<ol><li>x</li></ol>');
    expect(ol).toContain('<ol>');
  });

  it('passthrough <h1>–<h4>: heading levels preserved', () => {
    for (const tag of ['h1', 'h2', 'h3', 'h4']) {
      const out = sanitize(`<${tag}>title</${tag}>`);
      expect(out).toContain(`<${tag}>title</${tag}>`);
    }
  });

  it('passthrough <blockquote>, <hr>: structural tags preserved', () => {
    expect(sanitize('<blockquote>quoted</blockquote>')).toContain(
      '<blockquote>quoted</blockquote>',
    );
    expect(sanitize('<p>before</p><hr><p>after</p>')).toMatch(/<hr\s*\/?>/);
  });

  // ---- Forbidden tags — FR-002a strip rules -------------------------

  it('strips <script> tags entirely (XSS vector)', () => {
    const out = sanitize('<p>safe</p><script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<p>safe</p>');
  });

  it('strips <style> tags entirely (CSS injection)', () => {
    const out = sanitize('<style>body{display:none}</style><p>ok</p>');
    expect(out).not.toContain('<style>');
    expect(out).not.toContain('display:none');
  });

  it('strips <iframe> tags entirely (frame-injection)', () => {
    const out = sanitize('<iframe src="https://evil.com"></iframe><p>ok</p>');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('evil.com');
  });

  it('strips <form> tags entirely (data exfiltration)', () => {
    const out = sanitize(
      '<p>safe</p><form action="https://evil.com"><input/></form>',
    );
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<input');
    expect(out).toContain('<p>safe</p>');
  });

  it('strips <link>, <meta>, <base> tags entirely', () => {
    const out = sanitize(
      '<link rel="stylesheet" href="x"><meta charset="utf"><base href="y"><p>ok</p>',
    );
    expect(out).not.toContain('<link');
    expect(out).not.toContain('<meta');
    expect(out).not.toContain('<base');
    expect(out).toContain('<p>ok</p>');
  });

  it('strips <object>, <embed>, <svg> tags entirely', () => {
    const out = sanitize(
      '<object data="x"></object><embed src="x"/><svg><circle/></svg><p>ok</p>',
    );
    expect(out).not.toContain('<object');
    expect(out).not.toContain('<embed');
    expect(out).not.toContain('<svg');
    expect(out).not.toContain('<circle');
  });

  // F7.1a US2 (T078) — `<img>` reinstated at sanitiser layer with
  // http(s)-only src enforcement; per-tenant source allowlist enforced
  // at Application use-case layer (validateImageSourceAllowlist).
  // Pre-F7.1a behavior (`<img>` stripped entirely as a tracking-pixel
  // mitigation per Critique 2026-04-29 E9/X3) is superseded by FR-009
  // + FR-010 + FR-014.
  it('preserves <img> tags with http(s) src (F7.1a US2 — source allowlist runs at use-case layer)', () => {
    const out = sanitize(
      '<p>ok</p><img src="https://cdn.example.com/banner.png" alt="banner"/>',
    );
    expect(out).toContain('<img');
    expect(out).toContain('cdn.example.com');
    expect(out).toContain('alt="banner"');
    expect(out).toContain('<p>ok</p>');
  });

  it('strips src from <img> with non-http(s) schemes (FR-014)', () => {
    const cases = [
      'data:text/html,<script>alert(1)</script>',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
    ];
    for (const badSrc of cases) {
      const out = sanitize(`<p>ok</p><img src="${badSrc}"/>`);
      expect(out).not.toContain(badSrc);
      // The <img> element survives but with src removed — visible
      // signal to the author + harmless render. The use case at the
      // submit boundary still enforces per-tenant source allowlist
      // on any surviving src.
    }
  });

  // ---- Forbidden attributes -----------------------------------------

  it('strips on* event handlers (onclick, onerror, etc.)', () => {
    const out = sanitize('<p onclick="alert(1)" onerror="x()">click</p>');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('alert(1)');
  });

  it('strips inline style="..." attributes', () => {
    const out = sanitize('<p style="color:red">red</p>');
    expect(out).not.toContain('style=');
    expect(out).toContain('<p>red</p>');
  });

  // ---- URL scheme allowlist -----------------------------------------

  it('rejects javascript: URLs in <a href>', () => {
    const out = sanitize('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain('javascript:');
    // Text content preserved per FR-002a (link stripped, text kept)
    expect(out).toContain('click');
  });

  it('rejects data: URLs in <a href>', () => {
    const out = sanitize('<a href="data:text/html,<script>alert(1)</script>">click</a>');
    expect(out).not.toContain('data:');
    expect(out).not.toContain('<script>');
  });

  it('rejects file: URLs in <a href>', () => {
    const out = sanitize('<a href="file:///etc/passwd">click</a>');
    expect(out).not.toContain('file:');
    expect(out).toContain('click');
  });

  it('rejects vbscript: URLs in <a href>', () => {
    const out = sanitize('<a href="vbscript:msgbox(1)">click</a>');
    expect(out).not.toContain('vbscript:');
  });

  // ---- Mixed / edge payloads ----------------------------------------

  it('strips <script> nested inside <p> while preserving the <p>', () => {
    const out = sanitize('<p>before<script>x</script>after</p>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('<p>');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('strips comment-injected payloads (<!--<script>-->)', () => {
    const out = sanitize('<p>ok<!--<script>alert(1)</script>--></p>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<p>');
    expect(out).toContain('ok');
  });

  it('handles deeply nested forbidden tags', () => {
    const out = sanitize(
      '<p><strong><em><script>nested</script></em></strong></p>',
    );
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('nested');
    expect(out).toContain('<strong>');
  });

  it('handles malformed HTML gracefully (DOMPurify default behaviour)', () => {
    // Unclosed tags + missing quotes — DOMPurify must not throw
    const result = sanitizeHtml(deps, {
      rawHtml: '<p>open<strong>nested<em>x</p>',
    });
    expect(result.ok).toBe(true);
  });

  // ---- Determinism — FR-002a snapshot requirement -------------------

  it('determinism: same input produces identical output across runs', () => {
    const input =
      '<p><strong>hello</strong> <a href="https://example.com">link</a></p>';
    const a = sanitize(input);
    const b = sanitize(input);
    const c = sanitize(input);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('determinism: idempotent — sanitise(sanitise(input)) === sanitise(input)', () => {
    const input =
      '<p>safe</p><script>bad</script><a href="javascript:x">y</a><img src="x"/>';
    const once = sanitize(input);
    const twice = sanitize(once);
    expect(twice).toBe(once);
  });

  // ---- 200 KB body cap (FR-002f) ------------------------------------

  it('rejects body > 200 KB with broadcast_body_too_large', () => {
    // 201 KB of paragraph content
    const huge = '<p>' + 'a'.repeat(201 * 1024) + '</p>';
    const result = sanitizeHtml(deps, { rawHtml: huge });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_body_too_large');
    }
  });

  it('handles 200KB-sized HTML input without throwing (FR-002f); <200ms budget under RUN_PERF', () => {
    const oneEightyK = '<p>' + 'a'.repeat(180 * 1024) + '</p>';
    const start = performance.now();
    const result = sanitizeHtml(deps, { rawHtml: oneEightyK });
    const elapsed = performance.now() - start;
    // Functional invariant — always asserted: a 180KB input is processed and
    // returns ok. The load-tolerant 5s ceiling is a coarse guard against a gross
    // processing regression / pathological slowdown (this flat input has no
    // backtracking structure, so it is NOT a targeted ReDoS probe); the precise
    // budget lives in the RUN_PERF lane below.
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(5000);
    // Precise perf budget — perf lane only (RUN_PERF=1), see note at top.
    if (RUN_PERF) {
      expect(elapsed).toBeLessThan(200);
    }
  });

  // ---- Empty / edge cases -------------------------------------------

  it('returns broadcast_body_unsafe_html for empty input (no usable content)', () => {
    const result = sanitizeHtml(deps, { rawHtml: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_body_unsafe_html');
    }
  });

  it('returns plain text unchanged when no HTML tags present', () => {
    const out = sanitize('Just plain text without tags');
    expect(out).toBe('Just plain text without tags');
  });

  // ---- Defensive: sanitiser-port throws ------------------------------

  // Review I3 (2026-04-30): sanitiser-throw maps to `sanitizer_unavailable`
  // (5xx-class infra fault) NOT `broadcast_body_unsafe_html` (4xx user
  // fault). Distinct error code lets the route handler produce a
  // 500 internal_error + ops alert instead of gaslighting the user.
  it('sanitiser port throws Error → sanitizer_unavailable with err.message', () => {
    const throwingDeps = {
      sanitizer: {
        sanitize() {
          throw new Error('DOMPurify init failure');
        },
      },
    };
    const result = sanitizeHtml(throwingDeps, { rawHtml: '<p>any</p>' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('sanitizer_unavailable');
      if (result.error.kind === 'sanitizer_unavailable') {
        expect(result.error.reason).toBe('DOMPurify init failure');
      }
    }
  });

  it('sanitiser port throws non-Error → sanitizer_unavailable with "unknown sanitiser error"', () => {
    const throwingDeps = {
      sanitizer: {
        sanitize() {
          throw 'plain string';
        },
      },
    };
    const result = sanitizeHtml(throwingDeps, { rawHtml: '<p>any</p>' });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'sanitizer_unavailable') {
      expect(result.error.reason).toBe('unknown sanitiser error');
    }
  });
});
