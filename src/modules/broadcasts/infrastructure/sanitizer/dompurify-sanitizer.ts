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
import { installBroadcastSanitizerHooks, makeBroadcastSanitizerConfig } from '@/lib/broadcast-content-policy';
import type { HtmlSanitizerPort } from '../../application/ports/html-sanitizer-port';

// F119 T013/T014 — the ONE policy (SC-011). The tag / attribute / scheme
// lists that used to be declared here now live in
// `src/lib/broadcast-content-policy.ts`, read by this adapter, the editor's
// paste handler and the preview alike, so no stage can drift. `<img>` is
// always allowed on the server (source-allowlist enforced at the Application
// layer by validateImageSourceAllowlist; non-http(s) src stripped by the
// img-src-scheme hook below); the member editor narrows to `images: false`
// while the F7.1a US2 flag is off. `data-eb` (the design-block marker) is the
// only data attribute that survives.
//
// KEEP_CONTENT: true — preserves text inside non-allowlisted-but-not-
// forbidden tags (e.g., `<div>`, `<span>`). FORBIDDEN tags (script/style/
// iframe/etc.) have their content stripped regardless of this flag — see
// file docblock for the empirical verification.
const PURIFY_CONFIG = makeBroadcastSanitizerConfig({ images: true });

// F119 T014 — the post-attribute hook (link hardening + the `<img src>`
// scheme guard, FR-014) moved to `src/lib/broadcast-content-policy.ts` as
// `installBroadcastSanitizerHooks`, and is installed on BOTH this adapter and
// the editor's paste sanitiser: the pre-F119 editor had no hook, so a paste
// kept what the server later changed (the SC-011 divergence). The empirical
// notes that used to sit here (jsdom realm shape check, the data:-URI
// inflation defence) are on that function.

// R7 staff-review MED-S5 fix — Edge-runtime guard. The
// `installBroadcastSanitizerHooks` hook + its per-instance WeakSet rely
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
    installBroadcastSanitizerHooks(DOMPurify);
    const out = DOMPurify.sanitize(html, PURIFY_CONFIG as Parameters<typeof DOMPurify.sanitize>[1]) as unknown;
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
