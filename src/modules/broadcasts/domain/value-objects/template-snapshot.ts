/**
 * T097 (F7.1a US7) — Template snapshot Domain VO.
 *
 * Pure functions for template → draft substitution per critique E1/X1/E6
 * + contracts/broadcast-template.md § 5. `{{chamber_name}}` is the ONLY
 * server-substituted variable; HTML-escaped via shared `escapeHtml`
 * helper to prevent XSS via tenant-name injection.
 *
 * `[bracketed text]` is intentionally NOT touched — those are member-
 * editable placeholders rendered with distinct visual style in the
 * Tiptap editor (T116 compose-bracket-placeholder).
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */

/**
 * HTML-escape per OWASP — same 5 metachars as F7 MVP DOMPurify sanitiser.
 * Replaces `&` first so subsequent entity replacements don't get
 * double-escaped (`<` → `&lt;` not `&amp;lt;`).
 */
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Substitute `{{chamber_name}}` literal in template body/subject with
 * the tenant's display name (HTML-escaped first per § 5.1).
 *
 * Leaves `[bracketed text]` and ALL other `{{var}}` literals untouched
 * (deliberate — only chamber_name is server-resolved; other variables
 * were converted to bracket placeholders on 2026-05-18).
 *
 * Pure — no I/O, no clock, no globals.
 */
export function substituteChamberName(
  body: string,
  chamberName: string,
): string {
  const escaped = escapeHtml(chamberName);
  return body.replace(/\{\{chamber_name\}\}/g, escaped);
}
