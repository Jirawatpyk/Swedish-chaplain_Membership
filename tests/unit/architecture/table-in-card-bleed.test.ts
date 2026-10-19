/**
 * A table inside a card runs edge to edge (AURA `bleed`) instead of drawing a
 * second framed box inside the card (maintainer, 19 Oct 2026: "ตารางซ้อนกัน").
 * The list pages took `bleed` in PR B (AURA 5.27, #130); these are the tables
 * that still sat framed inside their card, found by measuring every preview
 * view at 1440 px for a bordered table wrapper under an `.aura-card`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TABLES_IN_CARDS: ReadonlyArray<readonly [file: string, caption: string]> = [
  ['src/components/directory/directory-table.tsx', 'staff directory'],
  ['src/app/(staff)/admin/marketing/audience/_components/audience-table.tsx', 'marketing audience'],
  ['src/app/(staff)/admin/renewals/_components/at-risk-widget.tsx', 'at-risk members'],
  ['src/app/(staff)/admin/members/[memberId]/_components/member-invoices-table.tsx', "a member's invoices"],
  ['src/app/(staff)/admin/invoices/[invoiceId]/_components/invoice-detail-view.tsx', 'invoice line items'],
  ['src/app/(member)/portal/invoices/page.tsx', 'portal invoices'],
  ['src/app/(member)/portal/invoices/[invoiceId]/page.tsx', 'portal invoice line items'],
];

/** Each `<Table …>` / `<DataTable…>` opening tag in the file, props included. */
function tableTags(source: string): string[] {
  const tags: string[] = [];
  const re = /<(?:Data)?Table\b/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 0;
    let i = m.index + m[0].length;
    // Skip a generic argument (`<DataTable<Row>`).
    if (source[i] === '<') i = source.indexOf('>', i) + 1;
    for (; i < source.length; i += 1) {
      const c = source[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0 && source[i - 1] !== '=') break;
    }
    tags.push(source.slice(m.index, i + 1));
  }
  return tags;
}

describe('tables inside a card bleed to its edges', () => {
  it.each(TABLES_IN_CARDS)('%s (%s) passes `bleed` on every table', (file) => {
    const tags = tableTags(readFileSync(join(process.cwd(), file), 'utf8').replace(/\r/g, ''));
    expect(tags.length, 'positive control: the file has a table').toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toMatch(/\sbleed\b/);
  });
});
