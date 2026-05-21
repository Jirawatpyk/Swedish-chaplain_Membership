/**
 * T069 (F7.1a US2) — Domain value-object for image-source allowlist.
 *
 * Pure functions only. No framework imports (Constitution Principle III
 * NON-NEGOTIABLE).
 *
 * Hostname format invariant (FR-010): RFC 1035 lowercase ASCII with
 * ≥1 dot; no wildcards. The brand keeps the invariant at the type
 * boundary so Application + Infrastructure layers cannot accept a
 * raw `string` as a hostname.
 *
 * F7.1b B1 closure 2026-05-21 (closes Plan.md Complexity Tracking #5):
 * the `Hostname` brand now lives at `./branded-types.ts` (Domain). This
 * file owns the runtime validator (`asHostname`) + membership semantics
 * (`validateHostname`).
 *
 * Membership semantics for `validateHostname` (FR-010 critique
 * E11 round 2): exact-match only. Subdomains do NOT inherit a parent
 * allowlist entry; admins must explicitly add each subdomain. This
 * keeps the allowlist auditable + prevents wildcard-via-subdomain
 * escalation.
 */
import { err, ok, type Result } from '@/lib/result';
import type { Hostname } from './branded-types';
import type { AllowlistEntry } from '../../application/ports/image-allowlist-port';

export type { Hostname };

export type HostnameError = {
  readonly kind: 'invalid_hostname';
  readonly detail: 'empty' | 'too_long' | 'rfc1035_format';
};

export type ValidateHostnameError = {
  readonly kind: 'not_allowlisted';
  readonly hostname: string;
};

/**
 * RFC 1035 hostname format: lowercase ASCII label(.label)+ — at least
 * one dot, no trailing dot, no wildcards. Each label is [a-z0-9] with
 * optional internal hyphens. Total length capped at 253 chars at the
 * validator (separate check below).
 *
 * PR-review fix 2026-05-20 TD-M5 — exported as a constant so the
 * admin allowlist route (`src/app/api/admin/broadcasts/settings/
 * allowlist/route.ts`) imports + uses this in its zod schema instead
 * of duplicating the regex literal. Migration 0164's DB CHECK
 * constraint remains as defence-in-depth (3-way: Domain VO + zod
 * route + DB CHECK) but the Domain VO is the single source of truth
 * the runtime + boot-time validators share.
 */
export const HOSTNAME_REGEX =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Validate and brand a hostname string per FR-010. */
export function asHostname(raw: string): Result<Hostname, HostnameError> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return err({ kind: 'invalid_hostname', detail: 'empty' });
  }
  if (raw.length > 253) {
    return err({ kind: 'invalid_hostname', detail: 'too_long' });
  }
  if (!HOSTNAME_REGEX.test(raw)) {
    return err({ kind: 'invalid_hostname', detail: 'rfc1035_format' });
  }
  return ok(raw as Hostname);
}

/** Exact-match membership check (no subdomain transitivity). */
export function validateHostname(
  candidate: Hostname,
  allowlist: readonly AllowlistEntry[],
): Result<void, ValidateHostnameError> {
  for (const entry of allowlist) {
    if (entry.hostname === candidate) return ok(undefined);
  }
  return err({ kind: 'not_allowlisted', hostname: candidate });
}

/**
 * Extract `<img>` tags from sanitised body HTML.
 *
 * NOT a full HTML parser. Uses a regex scoped to `<img ...>` and
 * strips known forbidden-tag content blocks (`<script>`, `<style>`)
 * first as belt-and-braces against an upstream sanitiser regression
 * that lets such tags through.
 *
 * Returns each `src` literal + optional `alt`. Document order
 * preserved so the use-case can map errors back to editor positions.
 */
export function extractImgSources(
  bodyHtml: string,
): ReadonlyArray<{ readonly src: string; readonly alt?: string }> {
  const stripped = bodyHtml
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');

  const out: Array<{ src: string; alt?: string }> = [];
  const imgRe = /<img\b([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = imgRe.exec(stripped)) !== null) {
    const attrs = match[1] ?? '';
    // LOW review fix 2026-05-21 (code-reviewer-full L-1): accept BOTH
    // single-quoted AND double-quoted src/alt attributes. Sanitised
    // bodies from DOMPurify always emit double-quotes, but a downstream
    // consumer that mutates output OR a future sanitiser config flag
    // could leak single-quoted forms. Defence-in-depth — the allowlist
    // validator MUST see every `<img src>` regardless of quote style.
    // Pattern: capture group [1] = double-quoted value, [2] = single-quoted.
    const srcMatch = /src\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs);
    const src = srcMatch?.[1] ?? srcMatch?.[2];
    if (!src) continue;
    const altMatch = /alt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const alt = altMatch?.[1] ?? altMatch?.[2];
    const entry: { src: string; alt?: string } = { src };
    if (alt !== undefined) entry.alt = alt;
    out.push(entry);
  }
  return out;
}
