/**
 * `parseDuplicateRefusal` — the New-invoice form's decision about whether a
 * failed POST /api/invoices is the recoverable duplicate refusal.
 *
 * Why this is a pure-function test rather than a rendered-dialog test: Base UI
 * dialog portals do not mount under this repo's jsdom setup, so no unit test
 * here asserts on a live AlertDialog — dialog mechanics are covered in
 * Playwright (tests/e2e/destructive-confirm.spec.ts). The branching that
 * actually decides whether an admin is asked to make a money decision is all
 * in this function, so it is tested where it can be tested honestly.
 *
 * The wire shape it consumes is pinned against the real route in
 * tests/contract/invoices/create-draft-duplicate-ack.contract.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { parseDuplicateRefusal } from '@/app/(staff)/admin/invoices/_components/invoice-form';

const EXISTING_ID = '11111111-1111-1111-1111-111111111111';

function refusal(existing: Record<string, unknown>) {
  return { error: { code: 'duplicate_membership_invoice', existing } };
}

describe('parseDuplicateRefusal', () => {
  it('extracts a fully-described ISSUED duplicate', () => {
    expect(
      parseDuplicateRefusal(
        refusal({
          invoice_id: EXISTING_ID,
          status: 'issued',
          document_number: 'SC-2026-0042',
          total_satang: '2140000',
        }),
      ),
    ).toEqual({
      invoiceId: EXISTING_ID,
      status: 'issued',
      documentNumber: 'SC-2026-0042',
      totalSatang: '2140000',
    });
  });

  it('keeps a DRAFT duplicate`s nulls — they mean "not numbered yet", not "unknown"', () => {
    expect(
      parseDuplicateRefusal(
        refusal({
          invoice_id: EXISTING_ID,
          status: 'draft',
          document_number: null,
          total_satang: null,
        }),
      ),
    ).toEqual({
      invoiceId: EXISTING_ID,
      status: 'draft',
      documentNumber: null,
      totalSatang: null,
    });
  });

  it.each([
    ['a different error code', { error: { code: 'settings_missing' } }],
    ['no error block at all', { ok: true }],
    ['null', null],
    ['undefined', undefined],
    ['a non-object', 'boom'],
  ])('returns null for %s', (_label, body) => {
    expect(parseDuplicateRefusal(body)).toBeNull();
  });

  it.each([
    ['no existing block', refusal({})],
    ['a missing invoice id', refusal({ status: 'issued' })],
    ['an empty invoice id', refusal({ invoice_id: '', status: 'issued' })],
    ['a missing status', refusal({ invoice_id: EXISTING_ID })],
    ['an empty status', refusal({ invoice_id: EXISTING_ID, status: '' })],
    ['a non-string invoice id', refusal({ invoice_id: 42, status: 'issued' })],
  ])('falls through to the ordinary error toast when the refusal has %s', (_label, body) => {
    // Deliberate: a confirmation dialog rendered with blanks where the
    // document number and amount belong is WORSE than a plain error, because
    // it asks for an informed decision while withholding the information.
    expect(parseDuplicateRefusal(body)).toBeNull();
  });

  it('coerces a non-string document number / total to null rather than rendering junk', () => {
    const parsed = parseDuplicateRefusal(
      refusal({
        invoice_id: EXISTING_ID,
        status: 'issued',
        document_number: 12345,
        total_satang: 2140000,
      }),
    );
    // `total_satang` crosses the wire as a STRING (bigint is not
    // JSON-serialisable); a number here means the contract drifted, so show
    // the "not yet totalled" affordance instead of a wrong-looking amount.
    expect(parsed?.documentNumber).toBeNull();
    expect(parsed?.totalSatang).toBeNull();
  });
});
