/**
 * 054-event-fee-invoices — GAP 1 coverage for `rowToSubjectFields`.
 *
 * Context
 * -------
 * `rowToSubjectFields` (drizzle-invoice-repo.ts) has 4 defensive throw
 * branches that fire when an `InvoiceRow` violates the DB CHECK
 * `invoices_subject_fields_ck` (migration 0208). In normal operation the
 * CHECK guarantees these rows can never arrive; but a legacy seed, a
 * manual DB patch, or a regressed write could bypass it. The throws turn
 * such a row into a loud {@link MalformedInvoiceSubjectError} rather than
 * constructing an {@link Invoice} that lies to its consumers.
 *
 * Because the seam is infra-only (it imports Drizzle table types), we
 * mirror the pattern from `pdf-union-partial-state.test.ts`: import the
 * exported function directly and feed it fabricated `InvoiceRow`-shaped
 * objects. The export is annotated `@internal` so no public-barrel rule
 * is violated.
 *
 * The 4 branches tested:
 *   B1 — membership row, missing member_id / plan_id / plan_year
 *   B2 — membership row, carries event_id / event_registration_id
 *   B3 — membership row, vat_inclusive = true (forbidden on membership)
 *   B4 — event row, missing event_id / event_registration_id
 *   B5 — event row, carries plan_id / plan_year
 *
 * (The spec comment groups B2+B3 as "branch 2" — the same `if` block;
 * we test each trigger condition separately for precision.)
 *
 * Happy-path arms (valid membership + valid event rows) confirm the
 * function returns the correct `InvoiceSubjectFields` shape so a
 * regression swapping a throw for a silent `?? null` is caught on both
 * paths.
 */
import { describe, it, expect } from 'vitest';
import type { InvoiceRow } from '@/modules/invoicing/infrastructure/db';
import {
  rowToSubjectFields,
  MalformedInvoiceSubjectError,
} from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';

// ---------------------------------------------------------------------------
// Minimal row factory — only the fields read by rowToSubjectFields matter.
// The remaining InvoiceRow columns are irrelevant to this unit; cast via
// `as InvoiceRow` keeps the type boundary honest without repeating 40+
// nullable columns.
// ---------------------------------------------------------------------------
function makeRow(
  fields: Pick<
    InvoiceRow,
    | 'invoiceId'
    | 'invoiceSubject'
    | 'memberId'
    | 'planId'
    | 'planYear'
    | 'eventId'
    | 'eventRegistrationId'
    | 'vatInclusive'
  >,
): InvoiceRow {
  return fields as unknown as InvoiceRow;
}

const INVOICE_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const MEMBER_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const PLAN_ID = 'corporate-gold';
const PLAN_YEAR = 2026;
const EVENT_ID = 'cccccccc-0000-0000-0000-000000000001';
const REG_ID = 'dddddddd-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Happy paths — confirm the function builds the correct shape for VALID rows.
// ---------------------------------------------------------------------------
describe('rowToSubjectFields — happy paths', () => {
  it('returns membership InvoiceSubjectFields for a valid membership row', () => {
    const row = makeRow({
      invoiceId: INVOICE_ID,
      invoiceSubject: 'membership',
      memberId: MEMBER_ID,
      planId: PLAN_ID,
      planYear: PLAN_YEAR,
      eventId: null,
      eventRegistrationId: null,
      vatInclusive: false,
    });

    const result = rowToSubjectFields(row);

    expect(result).toEqual({
      invoiceSubject: 'membership',
      memberId: MEMBER_ID,
      planId: PLAN_ID,
      planYear: PLAN_YEAR,
      eventId: null,
      eventRegistrationId: null,
      vatInclusive: false,
    });
  });

  it('returns event InvoiceSubjectFields for a valid event row (non-member buyer)', () => {
    const row = makeRow({
      invoiceId: INVOICE_ID,
      invoiceSubject: 'event',
      memberId: null,
      planId: null,
      planYear: null,
      eventId: EVENT_ID,
      eventRegistrationId: REG_ID,
      vatInclusive: false,
    });

    const result = rowToSubjectFields(row);

    expect(result).toEqual({
      invoiceSubject: 'event',
      memberId: null,
      planId: null,
      planYear: null,
      eventId: EVENT_ID,
      eventRegistrationId: REG_ID,
      vatInclusive: false,
    });
  });

  it('returns event InvoiceSubjectFields for a valid event row (matched member buyer)', () => {
    const row = makeRow({
      invoiceId: INVOICE_ID,
      invoiceSubject: 'event',
      memberId: MEMBER_ID,
      planId: null,
      planYear: null,
      eventId: EVENT_ID,
      eventRegistrationId: REG_ID,
      vatInclusive: true,
    });

    const result = rowToSubjectFields(row);

    expect(result.invoiceSubject).toBe('event');
    expect(result.memberId).toBe(MEMBER_ID);
    expect(result.vatInclusive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Throw branches — each tests one CHECK-violating row shape.
// ---------------------------------------------------------------------------
describe('rowToSubjectFields — MalformedInvoiceSubjectError throw branches (B1–B5)', () => {
  // B1 — membership row missing member_id / plan_id / plan_year
  it('B1: throws MalformedInvoiceSubjectError when membership row has null memberId', () => {
    const row = makeRow({
      invoiceId: INVOICE_ID,
      invoiceSubject: 'membership',
      memberId: null,        // violates CHECK
      planId: PLAN_ID,
      planYear: PLAN_YEAR,
      eventId: null,
      eventRegistrationId: null,
      vatInclusive: false,
    });

    expect(() => rowToSubjectFields(row)).toThrow(MalformedInvoiceSubjectError);
  });

  it('B1: error message names the invoice id and describes the missing identity', () => {
    const row = makeRow({
      invoiceId: INVOICE_ID,
      invoiceSubject: 'membership',
      memberId: null,
      planId: null,
      planYear: null,
      eventId: null,
      eventRegistrationId: null,
      vatInclusive: false,
    });

    expect(() => rowToSubjectFields(row)).toThrow(
      /membership row missing member_id\/plan_id\/plan_year/,
    );
    expect(() => rowToSubjectFields(row)).toThrow(new RegExp(INVOICE_ID));
  });

  // B2 — membership row carries event_id
  it('B2: throws when membership row carries a non-null eventId', () => {
    const row = makeRow({
      invoiceId: INVOICE_ID,
      invoiceSubject: 'membership',
      memberId: MEMBER_ID,
      planId: PLAN_ID,
      planYear: PLAN_YEAR,
      eventId: EVENT_ID,     // violates CHECK
      eventRegistrationId: null,
      vatInclusive: false,
    });

    expect(() => rowToSubjectFields(row)).toThrow(MalformedInvoiceSubjectError);
    expect(() => rowToSubjectFields(row)).toThrow(
      /membership row carries event_id\/event_registration_id or vat_inclusive=true/,
    );
  });

  // B2 — membership row carries eventRegistrationId
  it('B2: throws when membership row carries a non-null eventRegistrationId', () => {
    const row = makeRow({
      invoiceId: INVOICE_ID,
      invoiceSubject: 'membership',
      memberId: MEMBER_ID,
      planId: PLAN_ID,
      planYear: PLAN_YEAR,
      eventId: null,
      eventRegistrationId: REG_ID,  // violates CHECK
      vatInclusive: false,
    });

    expect(() => rowToSubjectFields(row)).toThrow(MalformedInvoiceSubjectError);
  });

  // B3 — membership row with vatInclusive=true
  it('B3: throws when membership row has vatInclusive=true', () => {
    const row = makeRow({
      invoiceId: INVOICE_ID,
      invoiceSubject: 'membership',
      memberId: MEMBER_ID,
      planId: PLAN_ID,
      planYear: PLAN_YEAR,
      eventId: null,
      eventRegistrationId: null,
      vatInclusive: true,   // violates CHECK
    });

    expect(() => rowToSubjectFields(row)).toThrow(MalformedInvoiceSubjectError);
    expect(() => rowToSubjectFields(row)).toThrow(
      /membership row carries event_id\/event_registration_id or vat_inclusive=true/,
    );
  });

  // B4 — event row missing event_id / event_registration_id
  it('B4: throws when event row has null eventId', () => {
    const row = makeRow({
      invoiceId: INVOICE_ID,
      invoiceSubject: 'event',
      memberId: null,
      planId: null,
      planYear: null,
      eventId: null,         // violates CHECK
      eventRegistrationId: REG_ID,
      vatInclusive: false,
    });

    expect(() => rowToSubjectFields(row)).toThrow(MalformedInvoiceSubjectError);
    expect(() => rowToSubjectFields(row)).toThrow(
      /event row missing event_id\/event_registration_id/,
    );
  });

  it('B4: throws when event row has null eventRegistrationId', () => {
    const row = makeRow({
      invoiceId: INVOICE_ID,
      invoiceSubject: 'event',
      memberId: null,
      planId: null,
      planYear: null,
      eventId: EVENT_ID,
      eventRegistrationId: null,  // violates CHECK
      vatInclusive: false,
    });

    expect(() => rowToSubjectFields(row)).toThrow(MalformedInvoiceSubjectError);
    expect(() => rowToSubjectFields(row)).toThrow(
      /event row missing event_id\/event_registration_id/,
    );
  });

  it('B4: error message includes the invoice id', () => {
    const row = makeRow({
      invoiceId: INVOICE_ID,
      invoiceSubject: 'event',
      memberId: null,
      planId: null,
      planYear: null,
      eventId: null,
      eventRegistrationId: null,
      vatInclusive: false,
    });

    expect(() => rowToSubjectFields(row)).toThrow(new RegExp(INVOICE_ID));
  });

  // B5 — event row carries plan_id / plan_year
  it('B5: throws when event row carries a non-null planId', () => {
    const row = makeRow({
      invoiceId: INVOICE_ID,
      invoiceSubject: 'event',
      memberId: null,
      planId: PLAN_ID,       // violates CHECK
      planYear: null,
      eventId: EVENT_ID,
      eventRegistrationId: REG_ID,
      vatInclusive: false,
    });

    expect(() => rowToSubjectFields(row)).toThrow(MalformedInvoiceSubjectError);
    expect(() => rowToSubjectFields(row)).toThrow(
      /event row carries plan_id\/plan_year/,
    );
  });

  it('B5: throws when event row carries a non-null planYear', () => {
    const row = makeRow({
      invoiceId: INVOICE_ID,
      invoiceSubject: 'event',
      memberId: null,
      planId: null,
      planYear: PLAN_YEAR,   // violates CHECK
      eventId: EVENT_ID,
      eventRegistrationId: REG_ID,
      vatInclusive: false,
    });

    expect(() => rowToSubjectFields(row)).toThrow(MalformedInvoiceSubjectError);
    expect(() => rowToSubjectFields(row)).toThrow(
      /event row carries plan_id\/plan_year/,
    );
  });

  it('B5: error message includes the invoice id', () => {
    const row = makeRow({
      invoiceId: INVOICE_ID,
      invoiceSubject: 'event',
      memberId: null,
      planId: PLAN_ID,
      planYear: PLAN_YEAR,
      eventId: EVENT_ID,
      eventRegistrationId: REG_ID,
      vatInclusive: false,
    });

    expect(() => rowToSubjectFields(row)).toThrow(new RegExp(INVOICE_ID));
  });
});
