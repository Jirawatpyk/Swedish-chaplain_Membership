/**
 * EN/TH/SV parity for the money/tax copy on the void, failed-auto-refund and
 * seller tax-ID paths (#415). `pnpm check:i18n` hard-fails missing TH/SV keys
 * only on main / release/*, so these keys — which tell an operator whether a
 * paid invoice can be voided and whether to issue a credit note — are pinned
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
  { path: 'admin.invoices.void.errors.paidInvoiceRequiresRefund', placeholders: [] },
  { path: 'admin.invoices.detail.voidDetails.creditNoteHint', placeholders: [] },
  { path: 'admin.invoices.detail.voidDetails.creditNoteHintBill', placeholders: ['{number}'] },
  { path: 'admin.invoices.detail.autoRefundFailed.resolveConfirm.body', placeholders: [] },
  { path: 'admin.invoiceSettings.errors.taxIdChecksum', placeholders: [] },
];

const LOCALES = [
  ['en', en],
  ['th', th],
  ['sv', sv],
] as const;

describe('void / failed-auto-refund / seller tax-ID copy — EN/TH/SV parity', () => {
  for (const { path, placeholders } of KEYS) {
    it(path, () => {
      for (const [locale, tree] of LOCALES) {
        const value = get(tree as Tree, path);
        expect(typeof value, `${locale}: ${path}`).toBe('string');
        expect((value as string).trim().length, `${locale}: ${path}`).toBeGreaterThan(0);
        for (const ph of placeholders) {
          expect(value as string, `${locale}: ${path} must carry ${ph}`).toContain(ph);
        }
      }
    });
  }

  it('the 088 bill void copy never claims a retired tax-document number', () => {
    // An SC ใบแจ้งหนี้ bill never carried a §87 / §86/4 number.
    for (const path of [
      'admin.invoices.void.descriptionBill',
      'admin.invoices.detail.voidDetails.creditNoteHintBill',
    ]) {
      expect(get(en as Tree, path) as string).not.toMatch(/tax-document number is retired/i);
    }
  });

  // Maintainer, 3 Oct 2026: EN names the SC- ใบแจ้งหนี้ "invoice" (its PDF
  // title), never "bill"; the §87 ใบกำกับภาษี stays "tax invoice".
  it('EN names the SC document "invoice", and the §87 one "tax invoice"', () => {
    const t = (path: string) => get(en as Tree, path) as string;
    expect(t('admin.invoices.list.filters.documentType.sc')).toBe('Invoice (SC)');
    expect(t('admin.invoices.issue.issueBillButtonPlain')).toBe('Issue invoice');
    expect(t('admin.invoices.issue.issueInvoiceButtonPlain')).toBe('Issue tax invoice');
    expect(t('admin.invoices.void.confirmCopyBill')).toBe('Type the invoice number to confirm');
    expect(t('admin.invoices.void.confirmCopy')).toBe('Type the tax invoice number to confirm');
    for (const path of [
      'admin.invoices.void.descriptionBill',
      'admin.invoices.detail.voidDetails.creditNoteHintBill',
      'admin.invoices.issue.issueBillButton',
      'shared.creditNoteOriginal.bill',
      'portal.invoices.detail.void.replacedBy',
    ]) {
      expect(t(path), path).not.toMatch(/\bbills?\b/i);
    }
  });

  // TH/SV follow-up: the SC document is ใบแจ้งหนี้ / faktura, never the
  // informal "บิล" or "räkning" (verbs such as "ออกบิลให้" = Bill to stay).
  it('TH/SV name the SC document ใบแจ้งหนี้ / faktura', () => {
    for (const path of [
      'admin.invoices.form.renewalContext.renewal',
      'admin.invoices.form.renewalContext.firstPayment',
      'admin.invoices.form.renewalContext.notApplicable',
      'admin.invoices.pay.errors.new_flow_bill_requires_flag_on',
      'admin.renewals.money.collectionRate.hint',
      'admin.renewals.suspendedBridge.line',
      'admin.renewals.table.billIssuedLabel',
      'admin.renewals.table.billIssuedTitle',
    ]) {
      expect(get(th as Tree, path) as string, `th: ${path}`).not.toMatch(/บิล/);
    }
    for (const path of [
      'admin.invoices.list.filters.documentType.sc',
      'admin.invoices.detail.voidDetails.creditNoteHintBill',
      'admin.invoices.void.descriptionBill',
      'shared.creditNoteOriginal.bill',
      'admin.invoiceSettings.hints.terminationNotice',
    ]) {
      expect(get(sv as Tree, path) as string, `sv: ${path}`).not.toMatch(/räkning|\bbill\b/i);
    }
    expect(get(sv as Tree, 'admin.invoices.list.filters.documentType.sc')).toBe('Faktura (SC)');
  });
});
