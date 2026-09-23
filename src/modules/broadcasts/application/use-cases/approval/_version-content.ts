/**
 * F119 T058 / T059 — the content rules a formatted version passes, at every
 * save AND again when it is sent to the member (FR-004: "cannot be sent to
 * the member until it passes"). ONE function, so the save and the send can
 * never apply different rules:
 *
 *   - subject: trimmed, 1–200 characters (`save-draft.ts` rule);
 *   - `sanitizeHtml` — the shared sanitiser policy + the 200 KB post-sanitise
 *     cap (design-block markup included, since the markers are in the HTML);
 *   - `validateBlocks(parseBlockMarkers(…))` — the FR-041 block rules;
 *   - `evaluateImageSources` — every `<img>` host on the tenant allow-list,
 *     each refusal naming the image, its host and the reason.
 *
 * Synchronous on purpose: the allow-list is read by the CALLER and handed in,
 * so the send can run this on the content it re-read under the broadcast row
 * lock without asking the pool for a second connection mid-transaction.
 *
 * Pure Application — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';
import {
  hasBlockViolations,
  parseBlockMarkers,
  validateBlocks,
  type BlockViolations,
} from '../../../domain/design-blocks/block-markers';
import {
  evaluateImageSources,
  type UnsafeImageSource,
} from '../../../domain/value-objects/image-source-allowlist';
import type { HtmlSanitizerPort } from '../../ports/html-sanitizer-port';
import type { AllowlistEntry } from '../../ports/image-allowlist-port';
import { sanitizeHtml } from '../sanitize-html';

/** Mirrors `broadcast_versions_subject_length` and `save-draft.ts`. */
export const FORMATTED_VERSION_SUBJECT_MAX = 200;

export type VersionContentError =
  | { readonly kind: 'subject_invalid'; readonly reason: 'empty' | 'too_long' }
  | { readonly kind: 'body_too_large'; readonly bytes: number }
  | { readonly kind: 'unsafe_content'; readonly reason: string }
  | { readonly kind: 'content_rules'; readonly violations: BlockViolations }
  | { readonly kind: 'image_source_not_allowlisted'; readonly images: readonly UnsafeImageSource[] }
  | { readonly kind: 'server_error'; readonly errKind: 'sanitizer_unavailable' };

export interface CheckedVersionContent {
  /** Trimmed. */
  readonly subject: string;
  /** As the shared sanitiser cleans it — what is stored. */
  readonly bodyHtml: string;
}

export function checkVersionContent(
  sanitizer: HtmlSanitizerPort,
  content: { readonly subject: string; readonly bodyHtml: string },
  allowlist: readonly AllowlistEntry[],
): Result<CheckedVersionContent, VersionContentError> {
  const subject = content.subject.trim();
  if (subject.length === 0) return err({ kind: 'subject_invalid', reason: 'empty' });
  if (subject.length > FORMATTED_VERSION_SUBJECT_MAX) return err({ kind: 'subject_invalid', reason: 'too_long' });

  const sanitised = sanitizeHtml({ sanitizer }, { rawHtml: content.bodyHtml });
  if (!sanitised.ok) {
    switch (sanitised.error.kind) {
      case 'broadcast_body_too_large':
        return err({ kind: 'body_too_large', bytes: sanitised.error.bytes });
      case 'broadcast_body_unsafe_html':
        return err({ kind: 'unsafe_content', reason: sanitised.error.reason });
      case 'sanitizer_unavailable':
        return err({ kind: 'server_error', errKind: 'sanitizer_unavailable' });
    }
  }
  const bodyHtml = sanitised.value.sanitisedHtml;

  const violations = validateBlocks(parseBlockMarkers(bodyHtml));
  if (hasBlockViolations(violations)) return err({ kind: 'content_rules', violations });

  const images = evaluateImageSources(bodyHtml, allowlist);
  if (images.length > 0) return err({ kind: 'image_source_not_allowlisted', images });

  return ok({ subject, bodyHtml });
}
