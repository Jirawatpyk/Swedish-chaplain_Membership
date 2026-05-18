/**
 * T013 (Feature 013 / F6.1) — EventCreate CSV adapter unit tests.
 *
 * Covers the pure functions in
 * `src/modules/events/infrastructure/eventcreate-csv-adapter.ts`:
 *   - detectEventCreateFormat (presence-of-6 case-sensitive + fallthrough)
 *   - normalizeAttendeeName   (title-case + hyphen/apostrophe preserve)
 *   - stripMailtoPrefix       (case-insensitive)
 *   - classifyEventCreateStatus + statusToPaymentStatus
 *     (FR-007 mirror EventCreate Status, Option B+ 2026-05-18)
 *   - translateEventCreateRow (end-to-end shape)
 *   - collectUnknownEventCreateColumns (FR-012 tolerance)
 *
 * RED-phase test inventory per plan.md § Constitution II.
 */
import { describe, it, expect } from 'vitest';
import {
  detectEventCreateFormat,
  normalizeAttendeeName,
  stripMailtoPrefix,
  classifyEventCreateStatus,
  statusToPaymentStatus,
  translateEventCreateRow,
  collectUnknownEventCreateColumns,
  EVENTCREATE_REQUIRED_COLUMNS,
} from '@/modules/events/infrastructure/eventcreate-csv-adapter';

// ---------------------------------------------------------------------------
// detectEventCreateFormat
// ---------------------------------------------------------------------------

describe('detectEventCreateFormat', () => {
  it('returns true when all 6 required columns are present (verbatim case)', () => {
    const header = [...EVENTCREATE_REQUIRED_COLUMNS];
    expect(detectEventCreateFormat(header)).toBe(true);
  });

  it('returns true when required columns are present alongside extras', () => {
    const header = [
      'Basic Info',
      'Phone Number',
      'Status',
      'Some New EventCreate Column',
      'First Name',
      'Last Name',
      'Email',
      'Tags',
      'Attendee ID',
    ];
    expect(detectEventCreateFormat(header)).toBe(true);
  });

  it('returns false when ONE required column is missing', () => {
    const header = ['Basic Info', 'Status', 'First Name', 'Last Name', 'Email'];
    // Missing: Attendee ID
    expect(detectEventCreateFormat(header)).toBe(false);
  });

  it('returns false on case-shifted columns (case-sensitive match)', () => {
    const header = [
      'basic info', // lowercased — should NOT match
      'Status',
      'First Name',
      'Last Name',
      'Email',
      'Attendee ID',
    ];
    expect(detectEventCreateFormat(header)).toBe(false);
  });

  it('returns false on Phase 7 generic-format header', () => {
    const header = [
      'event_external_id',
      'event_name',
      'event_start',
      'attendee_email',
      'attendee_name',
    ];
    expect(detectEventCreateFormat(header)).toBe(false);
  });

  it('returns false on empty header', () => {
    expect(detectEventCreateFormat([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeAttendeeName
// ---------------------------------------------------------------------------

describe('normalizeAttendeeName', () => {
  it('title-cases all-uppercase first+last', () => {
    expect(normalizeAttendeeName('JOHN STEWART', 'ANDERSON')).toBe(
      'John Stewart Anderson',
    );
  });

  it('preserves already-titlecase names', () => {
    expect(normalizeAttendeeName('Lars', 'Svensson')).toBe('Lars Svensson');
  });

  it('lowercases all-lowercase names', () => {
    expect(normalizeAttendeeName('anna', 'hammargren')).toBe('Anna Hammargren');
  });

  it('preserves hyphenated names with each segment capitalised', () => {
    expect(normalizeAttendeeName('Mary-Jane', 'ANDERSON-SMITH')).toBe(
      'Mary-Jane Anderson-Smith',
    );
  });

  it("preserves apostrophes (O'Brien)", () => {
    expect(normalizeAttendeeName("o'brien", 'mc-DONALD')).toBe(
      "O'Brien Mc-Donald",
    );
  });

  it('handles empty last name gracefully', () => {
    expect(normalizeAttendeeName('JANE', '')).toBe('Jane');
  });

  it('returns empty string when both names are blank', () => {
    expect(normalizeAttendeeName('', '')).toBe('');
    expect(normalizeAttendeeName('   ', '   ')).toBe('');
  });

  it('idempotent — normalize(normalize(x)) === normalize(x)', () => {
    const inputs: ReadonlyArray<readonly [string, string]> = [
      ['JOHN STEWART', 'ANDERSON'],
      ['Mary-Jane', "O'Brien"],
      ['  multiple   spaces  ', 'between'],
    ];
    for (const [first, last] of inputs) {
      const once = normalizeAttendeeName(first, last);
      const twice = normalizeAttendeeName(once, '');
      expect(twice).toBe(once);
    }
  });
});

// ---------------------------------------------------------------------------
// stripMailtoPrefix
// ---------------------------------------------------------------------------

describe('stripMailtoPrefix', () => {
  it('strips canonical lowercase `mailto:` prefix', () => {
    expect(stripMailtoPrefix('mailto:lars.svensson@midsummer.se')).toBe(
      'lars.svensson@midsummer.se',
    );
  });

  it('strips case-insensitive `MailTo:` prefix', () => {
    expect(stripMailtoPrefix('MAILTO:JANE@EXAMPLE.COM')).toBe('JANE@EXAMPLE.COM');
    expect(stripMailtoPrefix('MailTo:foo@bar.com')).toBe('foo@bar.com');
  });

  it('returns input unchanged when no mailto prefix present', () => {
    expect(stripMailtoPrefix('peter.borjesson@ericsson.com')).toBe(
      'peter.borjesson@ericsson.com',
    );
  });

  it('returns input unchanged when shorter than prefix length', () => {
    expect(stripMailtoPrefix('a@b')).toBe('a@b');
  });

  it('trims whitespace after stripping', () => {
    expect(stripMailtoPrefix('mailto:  spaced@example.com  ')).toBe(
      'spaced@example.com',
    );
  });
});

// ---------------------------------------------------------------------------
// classifyEventCreateStatus — F6.1 Option B+ (2026-05-18)
// Mirror EventCreate Status. Attending/Pending/Cancellation/Waitlisted/NoShow
// all become persisted registrations with the appropriate payment_status.
// Only unrecognised Status values flow into rowsSkipped.
// ---------------------------------------------------------------------------

describe('classifyEventCreateStatus', () => {
  it('returns Attending for exact "Attending" (case-sensitive)', () => {
    expect(classifyEventCreateStatus('Attending')).toBe('Attending');
  });

  it('returns Cancellation for "Cancelled" and "Canceled"', () => {
    expect(classifyEventCreateStatus('Cancelled')).toBe('Cancellation');
    expect(classifyEventCreateStatus('Canceled')).toBe('Cancellation');
  });

  it('returns Pending for "Pending" (Option B+)', () => {
    expect(classifyEventCreateStatus('Pending')).toBe('Pending');
  });

  it('returns Waitlisted for "Waitlisted" (Option B+)', () => {
    expect(classifyEventCreateStatus('Waitlisted')).toBe('Waitlisted');
  });

  it.each(['No Show', 'NoShow', 'No-Show'])(
    'returns NoShow for "%s" (Option B+ — all 3 EventCreate variants)',
    (input) => {
      expect(classifyEventCreateStatus(input)).toBe('NoShow');
    },
  );

  it('returns Skipped for lowercase "attending" (case-sensitive)', () => {
    expect(classifyEventCreateStatus('attending')).toBe('Skipped');
  });

  it('returns Skipped for unrecognised free-text Status values', () => {
    expect(classifyEventCreateStatus('Unknown Garbage')).toBe('Skipped');
    expect(classifyEventCreateStatus('pending')).toBe('Skipped'); // lowercase
  });

  it('returns Skipped for null / undefined / empty', () => {
    expect(classifyEventCreateStatus(null)).toBe('Skipped');
    expect(classifyEventCreateStatus(undefined)).toBe('Skipped');
    expect(classifyEventCreateStatus('')).toBe('Skipped');
  });

  it('trims whitespace before comparing', () => {
    expect(classifyEventCreateStatus('  Attending  ')).toBe('Attending');
    expect(classifyEventCreateStatus('  Pending  ')).toBe('Pending');
  });
});

// ---------------------------------------------------------------------------
// statusToPaymentStatus — F6.1 Option B+ mapping table
// ---------------------------------------------------------------------------

describe('statusToPaymentStatus', () => {
  it.each([
    ['Attending', 'paid'],
    ['Pending', 'pending'],
    ['Cancellation', 'refunded'],
    ['Waitlisted', 'waitlisted'],
    ['NoShow', 'no_show'],
  ] as const)('maps Status=%s → payment_status=%s', (status, expected) => {
    expect(statusToPaymentStatus(status)).toBe(expected);
  });

  it('returns null for Skipped (row dropped before persistence)', () => {
    expect(statusToPaymentStatus('Skipped')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// translateEventCreateRow — end-to-end happy path
// ---------------------------------------------------------------------------

describe('translateEventCreateRow', () => {
  it('translates a typical Attending row from real fixture shape', () => {
    const cells = new Map<string, string>([
      ['Basic Info', 'Lars Svensson'],
      ['Status', 'Attending'],
      ['First Name', 'Lars'],
      ['Last Name', 'Svensson'],
      ['Email', 'mailto:lars.svensson@midsummer.se'],
      ['Company Name', 'Midsummer AB'],
      ['Attendee ID', '16940826-1'],
      ['Ticket', 'SweCham Members'],
      // Notes cell present in real fixture but Option B+ no longer parses it
      ['Notes', 'verifying payment'],
      [
        'Personal Data Protection Consent',
        'I hereby acknowledge that I have read and understood…',
      ],
    ]);
    const row = translateEventCreateRow(cells);
    expect(row.status).toBe('Attending');
    expect(row.paymentStatus).toBe('paid');
    expect(row.intendedStateChange).toBe(false);
    expect(row.attendeeEmail).toBe('lars.svensson@midsummer.se');
    expect(row.attendeeName).toBe('Lars Svensson');
    expect(row.attendeeCompany).toBe('Midsummer AB');
    expect(row.attendeeExternalId).toBe('16940826-1');
    expect(row.ticketType).toBe('SweCham Members');
    expect(row.pdpaConsentAcknowledged).toBe(true);
  });

  it('Option B+ — Status=Pending → payment_status=pending (was Skipped pre-fix)', () => {
    const cells = new Map<string, string>([
      ['Status', 'Pending'],
      ['First Name', 'Jane'],
      ['Last Name', 'Doe'],
      ['Email', 'jane@example.com'],
      ['Attendee ID', '17000-1'],
    ]);
    const row = translateEventCreateRow(cells);
    expect(row.status).toBe('Pending');
    expect(row.paymentStatus).toBe('pending');
    expect(row.intendedStateChange).toBe(false);
  });

  it('Option B+ — Status=Waitlisted → payment_status=waitlisted', () => {
    const cells = new Map<string, string>([
      ['Status', 'Waitlisted'],
      ['First Name', 'Anna'],
      ['Last Name', 'Smith'],
      ['Email', 'anna@example.com'],
    ]);
    const row = translateEventCreateRow(cells);
    expect(row.status).toBe('Waitlisted');
    expect(row.paymentStatus).toBe('waitlisted');
  });

  it('Option B+ — Status="No Show" → payment_status=no_show', () => {
    const cells = new Map<string, string>([
      ['Status', 'No Show'],
      ['First Name', 'Maria'],
      ['Last Name', 'Jones'],
      ['Email', 'maria@example.com'],
    ]);
    const row = translateEventCreateRow(cells);
    expect(row.status).toBe('NoShow');
    expect(row.paymentStatus).toBe('no_show');
  });

  it('Status=Cancelled → Cancellation discriminator + payment_status=refunded + intendedStateChange', () => {
    const cells = new Map<string, string>([
      ['Status', 'Cancelled'],
      ['First Name', 'Jane'],
      ['Last Name', 'Doe'],
      ['Email', 'jane@example.com'],
    ]);
    const row = translateEventCreateRow(cells);
    expect(row.status).toBe('Cancellation');
    expect(row.paymentStatus).toBe('refunded');
    expect(row.intendedStateChange).toBe(true);
  });

  it('Status=blank → Skipped discriminator + null paymentStatus (row dropped)', () => {
    const cells = new Map<string, string>([
      ['Status', ''],
      ['First Name', 'Jane'],
      ['Last Name', 'Doe'],
      ['Email', 'jane@example.com'],
    ]);
    const row = translateEventCreateRow(cells);
    expect(row.status).toBe('Skipped');
    expect(row.paymentStatus).toBeNull();
  });

  it('does NOT parse Notes for payment status (Option B+ — drops Notes inference)', () => {
    // Pre-fix, "verifying payment" Notes would have set inferredPaymentStatus='pending'.
    // Option B+ ignores Notes entirely — Status alone drives payment_status.
    const cells = new Map<string, string>([
      ['Status', 'Attending'],
      ['First Name', 'X'],
      ['Last Name', 'Y'],
      ['Email', 'xy@example.com'],
      ['Notes', 'verifying payment'],
    ]);
    expect(translateEventCreateRow(cells).paymentStatus).toBe('paid');
  });

  it('omits attendeeExternalId and ticketType when cell is "–"', () => {
    const cells = new Map<string, string>([
      ['Status', 'Attending'],
      ['First Name', 'Jane'],
      ['Last Name', 'Doe'],
      ['Email', 'jane@example.com'],
      ['Attendee ID', '–'],
      ['Ticket', '–'],
    ]);
    const row = translateEventCreateRow(cells);
    expect(row.attendeeExternalId).toBeUndefined();
    expect(row.ticketType).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collectUnknownEventCreateColumns — FR-012 tolerance
// ---------------------------------------------------------------------------

describe('collectUnknownEventCreateColumns', () => {
  it('returns empty list when header contains only known columns', () => {
    const header = [
      ...EVENTCREATE_REQUIRED_COLUMNS,
      'Phone Number',
      'Company Name',
    ];
    expect(collectUnknownEventCreateColumns(header)).toHaveLength(0);
  });

  it('collects unknown columns verbatim, preserves order', () => {
    const header = [
      ...EVENTCREATE_REQUIRED_COLUMNS,
      'Brand New EventCreate Field',
      'Yet Another One',
      'Company Name',
      'Third Unknown',
    ];
    expect(collectUnknownEventCreateColumns(header)).toEqual([
      'Brand New EventCreate Field',
      'Yet Another One',
      'Third Unknown',
    ]);
  });

  it('collects custom EventCreate question-style columns (real fixture)', () => {
    // Both committed fixtures include free-text question columns like
    // `Please select your main course preference:`. These should appear
    // in the unknown list and feed the aggregate observability log.
    const header = [
      ...EVENTCREATE_REQUIRED_COLUMNS,
      'Please select your main course preference:',
      'Please advise us if you have any food allergies or special dietary requirements',
    ];
    const unknown = collectUnknownEventCreateColumns(header);
    expect(unknown).toContain('Please select your main course preference:');
    expect(unknown).toContain(
      'Please advise us if you have any food allergies or special dietary requirements',
    );
  });
});
