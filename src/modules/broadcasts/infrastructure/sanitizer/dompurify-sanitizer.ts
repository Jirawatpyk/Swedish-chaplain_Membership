/**
 * T058 — DOMPurify-backed `HtmlSanitizerPort` adapter (F7).
 *
 * Strict-allowlist HTML sanitisation per FR-002a (Constitution Principle IV
 * NON-NEGOTIABLE — OWASP A06). Wraps `isomorphic-dompurify@2.36.0`
 * (exact-pinned in package.json) with a frozen configuration object so
 * the same input always produces the same output across runs (T042).
 *
 * Allowlist (FR-002a + Critique 2026-04-29 E9/X3 — `<img>` REMOVED;
 * tracking-pixel vector):
 *   ALLOWED tags: p, br, strong, em, u, a[href], ul, ol, li,
 *                 h1, h2, h3, h4, blockquote, hr
 *   ALLOWED attrs: href, target, rel (target+rel are auto-forced via hook)
 *   ALLOWED URL schemes: http://, https://, mailto: only
 *   FORBIDDEN tags: script, style, iframe, form, link, meta, base,
 *                   object, embed, svg, img
 *   FORBIDDEN attrs: any `on*` event handler, inline `style`
 *
 * Hardening (review C3 — 2026-04-30):
 *
 *   1. **Link hardening** — `afterSanitizeAttributes` hook forces
 *      every surviving `<a>` to carry `rel="noopener noreferrer nofollow"`
 *      and `target="_blank"` so chamber sender reputation is decoupled
 *      from outbound links and recipients cannot be silently tab-napped.
 *
 *   2. **`KEEP_CONTENT: true` is INTENTIONAL and CORRECT** — verified
 *      empirically against `isomorphic-dompurify@2.36.0` + jsdom@25:
 *      forbidden tags (`<script>`, `<style>`, `<iframe>`, `<form>`,
 *      `<link>`, `<meta>`, `<base>`, `<object>`, `<embed>`, `<svg>`,
 *      `<img>`) have their **content removed entirely** regardless of
 *      `KEEP_CONTENT` because they're in `FORBID_TAGS`. `KEEP_CONTENT`
 *      only governs unknown / non-allowlisted-but-not-forbidden tags
 *      (e.g., `<div>`, `<span>`) — for those, `true` keeps the inner
 *      text (recipient-friendly) and `false` would also strip
 *      legitimate sibling text (test-fixture-confirmed bug). The
 *      reviewer's "<style> CSS leaks as visible text" concern does
 *      not apply because `<style>` is forbidden.
 */
import DOMPurify from 'isomorphic-dompurify';
import type { HtmlSanitizerPort } from '../../application/ports/html-sanitizer-port';

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'u',
  'a',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'blockquote',
  'hr',
] as const;

const ALLOWED_ATTR = ['href', 'target', 'rel'] as const;

const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:)/i;

const PURIFY_CONFIG = Object.freeze({
  ALLOWED_TAGS: [...ALLOWED_TAGS],
  ALLOWED_ATTR: [...ALLOWED_ATTR],
  ALLOWED_URI_REGEXP,
  FORBID_TAGS: [
    'script',
    'style',
    'iframe',
    'form',
    'link',
    'meta',
    'base',
    'object',
    'embed',
    'svg',
    'img',
  ],
  FORBID_ATTR: ['style'],
  // KEEP_CONTENT: true — preserves text inside non-allowlisted-but-
  // not-forbidden tags (e.g., `<div>`, `<span>`). FORBIDDEN tags
  // (script/style/iframe/etc.) have their content stripped regardless
  // of this flag — see file docblock for the empirical verification.
  KEEP_CONTENT: true,
  RETURN_TRUSTED_TYPE: false,
});

let hookInstalled = false;

function installLinkHardeningHook(): void {
  if (hookInstalled) return;
  // Force every surviving anchor to be safe regardless of input.
  // Hook fires once per element after attribute sanitisation.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (
      node instanceof Element &&
      node.tagName === 'A' &&
      node.hasAttribute('href')
    ) {
      node.setAttribute('rel', 'noopener noreferrer nofollow');
      node.setAttribute('target', '_blank');
    }
  });
  hookInstalled = true;
}

export const dompurifySanitizer: HtmlSanitizerPort = {
  sanitize(html: string): string {
    installLinkHardeningHook();
    const out = DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown;
    if (typeof out !== 'string') {
      // Defensive: with `RETURN_TRUSTED_TYPE: false` DOMPurify returns
      // a string, but a future SDK upgrade could break that contract.
      // Throw a typed error so the use-case maps to `sanitizer_unavailable`
      // rather than silently coercing into a downstream `Buffer.byteLength` crash.
      throw new Error('dompurify_returned_non_string');
    }
    return out;
  },
};
