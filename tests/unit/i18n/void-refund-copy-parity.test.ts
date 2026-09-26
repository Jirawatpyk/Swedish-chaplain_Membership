/**
 * EN/TH/SV parity for the money/tax copy on the void + failed-auto-refund
 * paths. `pnpm check:i18n` only hard-fails missing TH/SV keys on main, so these
 * keys — which tell an operator whether to issue a credit note — are pinned
 * here on every branch, together with their ICU placeholders.
 */
import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';

type Tree = Record<string, unknown>;

function get(tree: Tree, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (node, key) => (node && typeof node === 'object' ? (node as Tree)[key] : undefined),
    tree,
  );
}

const KEYS: ReadonlyArray<{ path: string; placeholders: readonly string[] }> = [
  { path: 'admin.invoices.void.description', placeholders: [] },
  { path: 'admin.invoices.void.descriptionBill', placeholders: ['{number}'] },
  { path: 'admin.invoices.void.terminalNotice', placeholders: [] },
  { path: 'admin.invoices.void.errors.paidMembershipRequiresCreditNote', placeholders: [] },
  { path: 'admin.invoices.void.errors.paidEventInvoiceRequiresReversal', placeholders: [] },
  { path: 'admin.invoices.detail.voidDetails.creditNoteHint', placeholders: [] },
  { path: 'admin.invoices.detail.voidDetails.creditNoteHintBill', placeholders: ['{number}'] },
  { path: 'admin.invoices.detail.autoRefundFailed.resolveConfirm.body', placeholders: [] },
  { path: 'admin.invoices.detail.autoRefundFailed.noCreditNote', placeholders: [] },
  { path: 'admin.invoiceSettings.errors.taxIdChecksum', placeholders: [] },
];

describe('void / failed-auto-refund / seller tax-ID copy — EN/TH/SV parity', () => {
  for (const { path, placeholders } of KEYS) {
    it(path, () => {
      for (const [locale, tree] of [
        ['en', en],
        ['th', th],
        ['sv', sv],
      ] as const) {
        const value = get(tree as Tree, path);
        expect(typeof value, `${locale}: ${path}`).toBe('string');
        expect((value as string).trim().length, `${locale}: ${path}`).toBeGreaterThan(0);
        for (const ph of placeholders) {
          expect(value as string, `${locale}: ${path} must carry ${ph}`).toContain(ph);
        }
      }
    });
  }

  it('the bill copy never claims a retired tax-document number', () => {
    const billEn = get(en as Tree, 'admin.invoices.void.descriptionBill') as string;
    expect(billEn).not.toMatch(/tax-document number is retired/i);
    const hintEn = get(en as Tree, 'admin.invoices.detail.voidDetails.creditNoteHintBill') as string;
    expect(hintEn).not.toMatch(/tax-document number is retired/i);
  });
});
