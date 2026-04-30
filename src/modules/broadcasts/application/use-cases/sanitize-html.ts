/**
 * T064 — `sanitize-html.ts` Application use-case (F7).
 *
 * Wraps `HtmlSanitizerPort.sanitize()` and enforces post-sanitisation
 * size cap (200 KB rendered HTML per FR-002a + FR-002f). Raw body is
 * NEVER persisted — the sanitised output replaces it before the
 * `broadcasts.body_html` insert.
 *
 * Pure Application logic — no framework imports (Constitution Principle III).
 *
 * Error taxonomy (review I3 — 2026-04-30):
 *   - `sanitizer_unavailable` (5xx-class): the sanitiser ITSELF threw
 *     (e.g., DOMPurify load failure, ESM crash, returned non-string).
 *     Caller maps to 500 internal_error + alerting; user content is
 *     valid, infra is broken. Log severity: error.
 *   - `broadcast_body_unsafe_html` (4xx-class): user content was
 *     stripped to nothing (every tag forbidden) — user fault, not
 *     infra. Caller maps to 400/422 with a clearer message.
 *   - `broadcast_body_too_large`: post-sanitisation size > 200 KB.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { HtmlSanitizerPort } from '../ports/html-sanitizer-port';

/** 200 KB rendered HTML cap (FR-002f). */
const MAX_BODY_HTML_BYTES = 200 * 1024;

export type SanitizeHtmlError =
  | { readonly kind: 'broadcast_body_too_large'; readonly bytes: number }
  | { readonly kind: 'broadcast_body_unsafe_html'; readonly reason: string }
  | { readonly kind: 'sanitizer_unavailable'; readonly reason: string };

export interface SanitizeHtmlDeps {
  readonly sanitizer: HtmlSanitizerPort;
}

export interface SanitizeHtmlInput {
  readonly rawHtml: string;
}

export interface SanitizeHtmlOutput {
  /** Allowlist-filtered HTML safe to persist + render. */
  readonly sanitisedHtml: string;
  /** Byte size of the sanitised HTML (octet_length equivalent). */
  readonly bytes: number;
}

export function sanitizeHtml(
  deps: SanitizeHtmlDeps,
  input: SanitizeHtmlInput,
): Result<SanitizeHtmlOutput, SanitizeHtmlError> {
  let sanitised: string;
  try {
    sanitised = deps.sanitizer.sanitize(input.rawHtml);
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown sanitiser error';
    // Sanitiser threw — infra fault, NOT user content. Log + escalate.
    logger.error(
      { err: reason, rawHtmlBytes: Buffer.byteLength(input.rawHtml, 'utf8') },
      'broadcasts.sanitize.sanitizer_unavailable',
    );
    return err({ kind: 'sanitizer_unavailable', reason });
  }

  const bytes = Buffer.byteLength(sanitised, 'utf8');
  if (bytes > MAX_BODY_HTML_BYTES) {
    return err({ kind: 'broadcast_body_too_large', bytes });
  }
  if (bytes === 0) {
    return err({
      kind: 'broadcast_body_unsafe_html',
      reason: 'sanitised body empty (all input was forbidden)',
    });
  }

  return ok({ sanitisedHtml: sanitised, bytes });
}
