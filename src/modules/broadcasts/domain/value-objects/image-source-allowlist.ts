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
 * The `Hostname` brand was declared in the Phase-2 port
 * (`image-allowlist-port.ts:44`) to avoid a circular Phase-2 ↔ Phase-4
 * ordering constraint. This file is the canonical Domain source for
 * the brand's runtime validator (`asHostname`).
 *
 * Membership semantics for `validateHostname` (FR-010 critique
 * E11 round 2): exact-match only. Subdomains do NOT inherit a parent
 * allowlist entry; admins must explicitly add each subdomain. This
 * keeps the allowlist auditable + prevents wildcard-via-subdomain
 * escalation.
 */
import { err, ok, type Result } from '@/lib/result';
import type {
  AllowlistEntry,
  Hostname,
} from '../../application/ports/image-allowlist-port';

export type { Hostname };

export type HostnameError = {
  readonly kind: 'invalid_hostname';
  readonly detail: 'empty' | 'too_long' | 'rfc1035_format';
};

export type ValidateHostnameError = {
  readonly kind: 'not_allowlisted';
  readonly hostname: string;
};

// RFC 1035 hostname format: lowercase ASCII label(.label)+ — at least
// one dot, no trailing dot, no wildcards. Each label is [a-z0-9] with
// optional internal hyphens. Total length capped at 253 chars at the
// validator (separate check below).
const HOSTNAME_REGEX =
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
    const srcMatch = /src\s*=\s*"([^"]+)"/i.exec(attrs);
    if (!srcMatch?.[1]) continue;
    const altMatch = /alt\s*=\s*"([^"]*)"/i.exec(attrs);
    const entry: { src: string; alt?: string } = { src: srcMatch[1] };
    if (altMatch?.[1] !== undefined) entry.alt = altMatch[1];
    out.push(entry);
  }
  return out;
}
