/**
 * The audience count sits at the end of the filter row from 640px up, as the
 * result count does on every other list (maintainer, 19 Oct 2026). The count
 * stays the results' own element (the live region, silent at zero, and the
 * focus target when the last row leaves a filtered view): the results stream
 * in after the filters, so the card's body wraps and places it beside the
 * filter bar when the bar's one-row width leaves room, instead of moving it
 * into the bar (a grid column squeezed the bar onto two rows at 1440).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const view = readFileSync(join(process.cwd(), 'src/app/(staff)/admin/marketing/audience/_components/audience-view.tsx'), 'utf8');
const filters = readFileSync(join(process.cwd(), 'src/app/(staff)/admin/marketing/audience/_components/audience-filters.tsx'), 'utf8');

describe('the audience count beside the filters', () => {
  it('the card body wraps from 640px: the filters take their one-row width as a basis, the count joins them when it fits', () => {
    expect(view).toMatch(/sm:flex-row sm:flex-wrap/);
    expect(view).toMatch(/sm:\[&>\*\]:basis-full/);
    expect(view).toMatch(/sm:\[&>\[data-audience-filters\]\]:basis-\[max-content\]/);
    expect(view).toMatch(/sm:\[&>#audience-count\]:basis-auto/);
  });

  it('the filters mark their root so the grid can place them', () => {
    expect(filters).toMatch(/data-audience-filters=""/);
  });
});
