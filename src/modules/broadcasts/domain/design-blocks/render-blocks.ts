/**
 * F119 T016 — render design blocks into platform-owned email markup (FR-041,
 * FR-041c, FR-042).
 *
 * Runs AFTER sanitisation and its output is NEVER fed back through DOMPurify
 * (the panel carry-forward): the table cells, `bgcolor` and inline styles
 * below are the platform's, not user content, and a second sanitiser pass
 * would strip exactly the attributes that make them render in Outlook.
 *
 * Degradation (FR-042): each block keeps the very element the user wrote —
 * the same `<a href>` with the same text, the same `<img src alt>` — so a
 * client that ignores the table still shows a plain link and a plain image.
 * Only the located marker spans are replaced; every other byte of the body
 * passes through untouched, which is what keeps the "no blocks" email
 * byte-identical (T007).
 *
 * Appearance is defined here and by the tenant's brand colour only. The
 * user supplies text, link, image and description — nothing else.
 */
import { DEFAULT_BRAND_PRIMARY_COLOR, type BrandHexColor } from '../brand/brand-settings';
import { findBlockMarkers, type DesignBlock } from './block-markers';

export interface DesignBlockBrand {
  /** `#rrggbb` or null ⇒ `DEFAULT_BRAND_PRIMARY_COLOR`. Email only (FR-041c). */
  readonly primaryColor: BrandHexColor | null;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderCta(block: Extract<DesignBlock, { kind: 'cta' }>, color: string): string {
  const href = escapeAttr(block.href);
  const text = escapeText(block.text);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0">` +
    `<tr><td bgcolor="${color}" style="border-radius:6px;background-color:${color}">` +
    `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow" ` +
    `style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:6px">` +
    `${text}</a></td></tr></table>`
  );
}

function renderBanner(block: Extract<DesignBlock, { kind: 'banner' }>): string {
  const src = escapeAttr(block.src);
  const alt = escapeAttr(block.alt);
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0">` +
    `<tr><td style="padding:0">` +
    `<img src="${src}" alt="${alt}" width="600" style="display:block;width:100%;max-width:100%;height:auto;border:0">` +
    `</td></tr></table>`
  );
}

/**
 * Replace every CTA / banner marker span with the platform markup. A body
 * without markers is returned as the identical string.
 */
export function applyDesignBlocks(sanitisedHtml: string, brand: DesignBlockBrand): string {
  const spans = findBlockMarkers(sanitisedHtml);
  if (spans.length === 0) return sanitisedHtml;
  const color = brand.primaryColor ?? DEFAULT_BRAND_PRIMARY_COLOR;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += sanitisedHtml.slice(cursor, span.start);
    out += span.block.kind === 'cta' ? renderCta(span.block, color) : renderBanner(span.block);
    cursor = span.end;
  }
  out += sanitisedHtml.slice(cursor);
  return out;
}
