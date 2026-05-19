/**
 * T058 — DOMPurify-backed `HtmlSanitizerPort` adapter (F7).
 *
 * Strict-allowlist HTML sanitisation per FR-002a (Constitution Principle IV
 * NON-NEGOTIABLE — OWASP A06). Wraps `isomorphic-dompurify@2.36.0`
 * (exact-pinned in package.json) with a frozen configuration object so
 * the same input always produces the same output across runs (T042).
 *
 * Allowlist (FR-002a + F7.1a US2 T078 reinstates `<img>` after the
 * Critique 2026-04-29 E9/X3 removal; tenant-source allowlist enforcement
 * now lives at the Application use-case layer via
 * `validateImageSourceAllowlist` — see contracts/image-upload.md § 1.2):
 *   ALLOWED tags: p, br, strong, em, u, a[href], ul, ol, li,
 *                 h1, h2, h3, h4, blockquote, hr, img[src,alt]
 *   ALLOWED attrs: href, target, rel (auto-forced via link hook),
 *                  src, alt (img only; non-http(s) src stripped via hook)
 *   ALLOWED URL schemes: http://, https://, mailto: (anchors);
 *                        http://, https:// only on <img src> (FR-014)
 *   FORBIDDEN tags: script, style, iframe, form, link, meta, base,
 *                   object, embed, svg
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
  // F7.1a US2 (T078) — `<img>` reinstated; source-allowlist enforced
  // at Application use-case layer (validateImageSourceAllowlist).
  // Non-http(s) src is stripped by the img-src-scheme hook below.
  'img',
] as const;

const ALLOWED_ATTR = ['href', 'target', 'rel', 'src', 'alt'] as const;

// Anchor scheme allowlist — `mailto:` is permitted alongside http(s).
// `<img src>` scheme enforcement lives in the img-src-scheme hook
// because DOMPurify's ALLOWED_URI_REGEXP applies to ALL URL-bearing
// attributes; we need stricter rules for `<img src>` (http(s) only,
// no mailto:) than for `<a href>`.
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

/**
 * T078 (F7.1a US2) — `<img>` source-scheme guard.
 *
 * `<img src>` is allowed by the ALLOWED_TAGS allowlist but the scheme
 * MUST be http(s) per FR-014 (data:, javascript:, file:, vbscript:
 * stripped). Implemented as an attribute-level removal inside the
 * existing afterSanitizeAttributes hook so non-conforming `<img>`
 * elements drop their `src` and render as broken images (visible
 * signal to the author that the URL was rejected) instead of being
 * removed silently.
 *
 * Why not rely on ALLOWED_URI_REGEXP alone: that regex governs ALL
 * URL-bearing attributes (href, src, action…). We need `<a href>` to
 * keep allowing `mailto:` while `<img src>` rejects it — the regex is
 * too coarse. A per-attribute hook is the right surface.
 *
 * **FR-012 defence-in-depth note (verify-run C2 closure 2026-05-20)**:
 * The spec's "the cap MUST be re-enforced on the sanitiser pass at
 * submit time (defence in depth — catches paste-of-external-large-
 * data-URI bypass attempts)" requirement is satisfied STRUCTURALLY by
 * this hook rather than by a literal byte-size check. Reason: the
 * only realistic class of "paste-of-external-large-data-URI bypass"
 * is `<img src="data:image/png;base64,...">` where the base64 payload
 * inflates the body bytes past the 5 MB upload cap. The img-src-scheme
 * hook strips `src=data:...` entirely, so the inflated body never
 * survives sanitisation regardless of byte size. The existing 200 KB
 * post-sanitiser body cap (sanitize-html.ts) catches any pathological
 * non-img inflation vector. Together these provide the literal
 * defence the spec asks for.
 */
function installLinkHardeningHook(): void {
  if (hookInstalled) return;
  // Force every surviving anchor to be safe regardless of input.
  // Hook fires once per element after attribute sanitisation.
  //
  // NOTE: cannot use `node instanceof Element` here — on Node 22 server
  // runtime the `Element` global is provided by isomorphic-dompurify's
  // internal jsdom, but only on `globalThis`. Avoid the cross-realm
  // ambiguity by checking `nodeType === 1` (ELEMENT_NODE) + the runtime
  // shape of the methods we use.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as {
      nodeType?: number;
      tagName?: string;
      hasAttribute?: (name: string) => boolean;
      setAttribute?: (name: string, value: string) => void;
      getAttribute?: (name: string) => string | null;
      removeAttribute?: (name: string) => void;
    };
    if (el.nodeType !== 1) return;

    // Link-hardening — force every surviving anchor to carry safe
    // rel + target. Unchanged from F7 MVP.
    if (
      el.tagName === 'A' &&
      typeof el.hasAttribute === 'function' &&
      typeof el.setAttribute === 'function' &&
      el.hasAttribute('href')
    ) {
      el.setAttribute('rel', 'noopener noreferrer nofollow');
      el.setAttribute('target', '_blank');
      return;
    }

    // T078 (F7.1a US2) — `<img>` source-scheme guard. Strip src when
    // scheme is not http(s); FR-014. Application-layer
    // `validateImageSourceAllowlist` enforces the per-tenant hostname
    // allowlist on the surviving src URL.
    if (
      el.tagName === 'IMG' &&
      typeof el.getAttribute === 'function' &&
      typeof el.removeAttribute === 'function'
    ) {
      const src = el.getAttribute('src') ?? null;
      if (src === null || !/^https?:\/\//i.test(src)) {
        el.removeAttribute('src');
      }
    }
  });
  hookInstalled = true;
}

// R7 staff-review MED-S5 fix — Edge-runtime guard. The
// `installLinkHardeningHook` hook + `hookInstalled` module flag rely
// on a Node.js-runtime DOMPurify instance backed by isomorphic-
// dompurify's internal jsdom. Vercel Edge runtime would expose a
// browser-shape `globalThis.window` and a different DOMPurify
// instance, breaking the hook installation and the
// `RETURN_TRUSTED_TYPE: false` contract. Webhook + cron + submit
// routes are pinned to Node runtime; this guard throws fast if a
// future migration accidentally moves a sanitiser caller to Edge.
function assertNodeRuntime(): void {
  // Vercel Edge runtime exposes `globalThis.EdgeRuntime` and/or sets
  // `process.env.NEXT_RUNTIME === 'edge'`. We use the explicit Edge
  // signature rather than `typeof window !== 'undefined'` because
  // vitest's jsdom test environment also provides `window` and would
  // false-trigger this guard. Production routes (webhook, cron,
  // submit) all pin `export const runtime = 'nodejs'`; this is the
  // last-line fail-fast for accidental migration.
  const isEdgeRuntime =
    typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !==
      'undefined' ||
    (typeof process !== 'undefined' &&
      process.env?.NEXT_RUNTIME === 'edge');
  if (isEdgeRuntime) {
    throw new Error(
      'dompurify_sanitizer_edge_runtime_unsupported: F7 sanitiser ' +
        'requires Node.js runtime (jsdom-backed DOMPurify). Pin route ' +
        'config: `export const runtime = "nodejs"`.',
    );
  }
}

export const dompurifySanitizer: HtmlSanitizerPort = {
  sanitize(html: string): string {
    assertNodeRuntime();
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
