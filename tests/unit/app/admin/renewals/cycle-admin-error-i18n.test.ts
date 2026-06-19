/**
 * DV-5 — EN i18n coverage pin for `CycleAdminActions` (cancel-cycle +
 * mark-paid-offline error toasts + the success/dialog copy it reads).
 *
 * The component surfaces each route's `{ error: { code } }` via
 * `t(\`cancelCycle.error.${code}\`)` / `t(\`markPaidOffline.error.${code}\`)`
 * with a `t.has(...)` + `server_error` fallback. Unit tests mock next-intl
 * (t() never throws on a missing key) and `check:i18n` is parity-only (not
 * code-ref-aware), so a route error code WITHOUT an EN key would pass every
 * gate and render the generic server_error copy at runtime instead of its own
 * message.
 *
 * EN is canonical (a missing EN key is the crash/wrong-copy class; TH/SV
 * parity is `check:i18n`'s job). We assert against the REAL en.json so a key
 * rename/removal fails this test — NOT a rendered Base UI dialog (which
 * deadlocks under jsdom + React 19 startTransition, see the dialog-jsdom-hang
 * memory). Static leaf coverage is the right seam.
 */
import { describe, expect, it } from 'vitest';
import {
  CANCEL_CYCLE_ERROR_CODES,
  MARK_PAID_OFFLINE_ERROR_CODES,
  resolveOrphanInvoiceHref,
} from '@/app/(staff)/admin/renewals/[cycleId]/_components/cycle-admin-error-codes';
import en from '@/i18n/messages/en.json';

const cd = (
  en as unknown as {
    admin: {
      renewals: {
        cycleDetail: {
          cancelCycle: {
            error: Record<string, string | undefined>;
          } & Record<string, unknown>;
          markPaidOffline: {
            paymentMethod: Record<string, string | undefined>;
            error: Record<string, string | undefined>;
          } & Record<string, unknown>;
        };
      };
    };
  }
).admin.renewals.cycleDetail;

describe('CycleAdminActions cancel-cycle — EN i18n coverage (DV-5)', () => {
  const errors = cd.cancelCycle.error;

  it('every route-emittable cancel error code has a non-empty error.* EN key', () => {
    const missing = CANCEL_CYCLE_ERROR_CODES.filter(
      (code) =>
        typeof errors[code] !== 'string' || errors[code]!.length === 0,
    );
    expect(
      missing,
      `Missing/empty EN copy for cancel error code(s): ${missing.join(', ')} — ` +
        'add `admin.renewals.cycleDetail.cancelCycle.error.<code>` to en.json ' +
        '(+ th/sv for check:i18n parity).',
    ).toEqual([]);
  });

  it('the cancel success/dialog keys the component reads are present', () => {
    const block = cd.cancelCycle as Record<string, unknown>;
    for (const k of [
      'button',
      'dialogTitle',
      'dialogBody',
      'reasonLabel',
      'reasonPlaceholder',
      'reasonRequired',
      'confirm',
      'cancel',
      'submitting',
      'successToast',
    ]) {
      expect(typeof block[k], `cancelCycle.${k}`).toBe('string');
    }
  });
});

describe('CycleAdminActions mark-paid-offline — EN i18n coverage (DV-5)', () => {
  const errors = cd.markPaidOffline.error;

  it('every route-emittable mark-paid error code has a non-empty error.* EN key', () => {
    const missing = MARK_PAID_OFFLINE_ERROR_CODES.filter(
      (code) =>
        typeof errors[code] !== 'string' || errors[code]!.length === 0,
    );
    expect(
      missing,
      `Missing/empty EN copy for mark-paid error code(s): ${missing.join(', ')} — ` +
        'add `admin.renewals.cycleDetail.markPaidOffline.error.<code>` to en.json ' +
        '(+ th/sv for check:i18n parity).',
    ).toEqual([]);
  });

  it('the mark-paid success/dialog/field keys the component reads are present', () => {
    const block = cd.markPaidOffline as Record<string, unknown>;
    for (const k of [
      'button',
      'dialogTitle',
      'dialogBody',
      'paymentMethodLabel',
      'paymentReferenceLabel',
      'paymentReferencePlaceholder',
      'paymentDateLabel',
      'confirm',
      'cancel',
      'submitting',
      'successToast',
      'viewOrphanInvoice',
    ]) {
      expect(typeof block[k], `markPaidOffline.${k}`).toBe('string');
    }
  });

  it('the 3 payment-method option labels are present', () => {
    const pm = cd.markPaidOffline.paymentMethod;
    for (const m of ['bank_transfer', 'cash', 'cheque']) {
      expect(typeof pm[m], `markPaidOffline.paymentMethod.${m}`).toBe('string');
    }
  });
});

describe('resolveOrphanInvoiceHref (DV-5 mark-paid DO-NOT-RETRY deep-link)', () => {
  it('returns the encoded invoice deep-link for f4_orphan_invoice with an id', () => {
    expect(
      resolveOrphanInvoiceHref({
        code: 'f4_orphan_invoice',
        orphan_invoice_id: 'inv-123',
      }),
    ).toBe('/admin/invoices/inv-123');
  });

  it('encodes the invoice id (path-injection / special chars are escaped)', () => {
    expect(
      resolveOrphanInvoiceHref({
        code: 'f4_orphan_invoice',
        orphan_invoice_id: 'a/b c',
      }),
    ).toBe(`/admin/invoices/${encodeURIComponent('a/b c')}`);
  });

  it('returns null for f4_orphan_invoice WITHOUT an id (→ generic toast)', () => {
    expect(resolveOrphanInvoiceHref({ code: 'f4_orphan_invoice' })).toBeNull();
  });

  it('returns null for any other code, even when an id is present', () => {
    expect(
      resolveOrphanInvoiceHref({
        code: 'cycle_not_payable',
        orphan_invoice_id: 'inv-123',
      }),
    ).toBeNull();
    expect(resolveOrphanInvoiceHref({ code: 'server_error' })).toBeNull();
  });
});
