/**
 * F119 T140 (FR-046) — "is there anything here to lose?".
 *
 * Template selection asks for confirmation only when the subject or the
 * message is non-empty. Tiptap never hands back an empty string: an untouched
 * editor serialises as `<p></p>`, and a cleared one as `<p></p>` or a chain of
 * empty paragraphs, so a `bodyHtml.length > 0` test would treat every fresh
 * form as "has content" and put a confirmation in front of the first template
 * pick — the exact friction FR-046 is trying to avoid.
 *
 * Void elements carry content without carrying text (an image, a divider, a
 * banner), so they count as content even though stripping tags leaves nothing.
 */
const TAG_RE = /<[^>]*>/g;
const NBSP_RE = /(&nbsp;| )/g;
const VOID_CONTENT_RE = /<(?:img|hr)\b/i;

export function composeHasContent(subject: string, bodyHtml: string): boolean {
  if (subject.trim().length > 0) return true;
  if (VOID_CONTENT_RE.test(bodyHtml)) return true;
  return bodyHtml.replace(TAG_RE, ' ').replace(NBSP_RE, ' ').trim().length > 0;
}
