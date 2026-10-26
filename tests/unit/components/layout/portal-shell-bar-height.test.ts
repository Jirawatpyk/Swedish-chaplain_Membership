/**
 * R89 recheck (spec 122 US12d-2): the portal's `--shell-bar-height` is what
 * sticky page parts (the E-Blast editor toolbar, the preview pane) stop
 * below. It must equal the portal header's height plus its 1px bottom
 * border at every width. The phone value was missing, so the toolbar stuck
 * at the 56px default and slid 8px under the 64px header.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '../../../..');
const layout = readFileSync(join(root, 'src/app/(member)/portal/layout.tsx'), 'utf8');
const header = readFileSync(join(root, 'src/components/layout/member-header.tsx'), 'utf8');

function px(source: string, pattern: RegExp): number {
  const match = pattern.exec(source);
  expect(match, String(pattern)).not.toBeNull();
  return Number(match![1]);
}

describe('the portal shell bar height matches the portal header', () => {
  it('on a phone', () => {
    const bar = px(layout, /(?:^|[\s"])\[--shell-bar-height:(\d+)px\]/);
    const rowHeight = px(header, /(?:^|\s)h-\[(\d+)px\]/);
    expect(bar).toBe(rowHeight + 1);
  });

  it('from lg', () => {
    const bar = px(layout, /lg:\[--shell-bar-height:(\d+)px\]/);
    const rowHeight = px(header, /lg:h-\[(\d+)px\]/);
    expect(bar).toBe(rowHeight + 1);
  });
});
