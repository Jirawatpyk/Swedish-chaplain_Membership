/**
 * PR R (AURA 5.89) — the portal pay sheet's Drawer names Stripe's 3-D Secure
 * layer in `keepOutside`, so the challenge stays clickable while the Drawer
 * makes the page behind it inert (#206). AURA's built-in keep list and its
 * "late body children stay live" contract cover it today (handoff addendum
 * 109, R145), and since 5.90 the built-in list names this selector too; this
 * keeps an explicit pin in our own code, on the money screen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILE = join(
  process.cwd(),
  'src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/index.tsx',
);

describe('pay sheet Drawer keeps Stripe 3DS live (AURA #206)', () => {
  it('passes keepOutside="[data-react-aria-top-layer]" to its Drawer', () => {
    const src = readFileSync(FILE, 'utf8');
    const drawer = src.slice(src.indexOf('<Drawer'), src.indexOf('>', src.indexOf('title={t(')));
    expect(src.indexOf('<Drawer')).toBeGreaterThan(-1);
    expect(drawer).toContain('keepOutside="[data-react-aria-top-layer]"');
  });
});
