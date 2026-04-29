/**
 * T028 — `HtmlSanitizerPort` Application port (F7).
 *
 * Strict-allowlist HTML sanitisation contract for FR-002a (NON-NEGOTIABLE
 * per Plan § Constitution OWASP A06). Concrete adapter wraps
 * `isomorphic-dompurify@2.36.0` (exact-pinned in package.json).
 *
 * Allowlist (FR-002a + Critique 2026-04-29 E9/X3 — `<img>` REMOVED from
 * MVP allowlist; tracking-pixel vector):
 *   ALLOWED tags: p, br, strong, em, u, a[href], ul, ol, li, h1–h4,
 *                 blockquote, hr
 *   FORBIDDEN tags: script, style, iframe, form, link, meta, base,
 *                   object, embed, svg, img, all `on*` event handlers,
 *                   inline `style`
 *   URL schemes: http://, https://, mailto: only
 *
 * Determinism: same input MUST produce identical output across runs.
 * The Application use-case `sanitize-html.ts` (Phase 3) wraps this
 * port and runs the sanitiser BEFORE persistence — the unsanitised
 * raw editor output is NEVER stored in `broadcasts.body_html`.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

export type HtmlSanitizerError = {
  readonly kind: 'sanitizer.parse_error';
  readonly message: string;
};

export interface HtmlSanitizerPort {
  /**
   * Sanitise member-supplied HTML against the FR-002a allowlist.
   * Returns the sanitised HTML string; throws `HtmlSanitizerError` on
   * unrecoverable parse failure (extremely rare with DOMPurify which
   * tolerates malformed input by default — surfaced for observability
   * if the adapter chooses to enable strict mode).
   */
  sanitize(html: string): string;
}
