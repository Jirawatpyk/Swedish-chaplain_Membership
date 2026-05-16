/**
 * T013 (Feature 013 / F6.1) — EventCreate CSV adapter unit tests.
 *
 * Covers the pure functions in
 * `src/modules/events/infrastructure/eventcreate-csv-adapter.ts`:
 *   - detectEventCreateFormat (presence-of-6 case-sensitive + fallthrough)
 *   - normalizeAttendeeName   (title-case + hyphen/apostrophe preserve)
 *   - stripMailtoPrefix       (case-insensitive)
 *   - inferPaymentStatus      (R5 closed mapping table)
 *   - classifyEventCreateStatus (FR-007 Attending vs Skipped)
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
  inferPaymentStatus,
  classifyEventCreateStatus,
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
// inferPaymentStatus — R5 closed mapping table
// ---------------------------------------------------------------------------

describe('inferPaymentStatus', () => {
  it.each([
    ['Paid', 'paid'],
    ['paid', 'paid'],
    ['PAID', 'paid'],
    ['  Paid  ', 'paid'],
    ['invoice sent', 'paid'],
    ['Invoice Sent', 'paid'],
    ['verifying payment', 'pending'],
    ['Verifying Payment', 'pending'],
    ['pending', 'pending'],
    ['Pending', 'pending'],
  ] as const)('maps "%s" → %s', (input, expected) => {
    expect(inferPaymentStatus(input)).toBe(expected);
  });

  it.each([
    ['', 'unknown'],
    ['-', 'unknown'],
    ['–', 'unknown'], // en-dash
    ['random unrecognized text', 'unknown'],
  ] as const)('maps "%s" → unknown (R5 default)', (input, expected) => {
    expect(inferPaymentStatus(input)).toBe(expected);
  });

  it('returns unknown for null and undefined', () => {
    expect(inferPaymentStatus(null)).toBe('unknown');
    expect(inferPaymentStatus(undefined)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// classifyEventCreateStatus — FR-007 Attending filter
// ---------------------------------------------------------------------------

describe('classifyEventCreateStatus', () => {
  it('returns Attending for exact "Attending" (case-sensitive)', () => {
    expect(classifyEventCreateStatus('Attending')).toBe('Attending');
  });

  // F6.1 Phase 4 US2 (T033) — Cancelled / Canceled rows now flow through
  // the parser as `Cancellation` (intendedStateChange=true downstream)
  // so the FR-018 refund branch can flip a previously-paid registration.
  // All other non-Attending values remain `Skipped`.
  it('returns Cancellation for "Cancelled" and "Canceled"', () => {
    expect(classifyEventCreateStatus('Cancelled')).toBe('Cancellation');
    expect(classifyEventCreateStatus('Canceled')).toBe('Cancellation');
  });

  it('returns Skipped for other non-Attending Status values', () => {
    expect(classifyEventCreateStatus('Waitlisted')).toBe('Skipped');
    expect(classifyEventCreateStatus('No Show')).toBe('Skipped');
    expect(classifyEventCreateStatus('Pending')).toBe('Skipped');
  });

  it('returns Skipped for lowercase "attending" (case-sensitive)', () => {
    expect(classifyEventCreateStatus('attending')).toBe('Skipped');
  });

  it('returns Skipped for null / undefined / empty', () => {
    expect(classifyEventCreateStatus(null)).toBe('Skipped');
    expect(classifyEventCreateStatus(undefined)).toBe('Skipped');
    expect(classifyEventCreateStatus('')).toBe('Skipped');
  });

  it('trims whitespace before comparing', () => {
    expect(classifyEventCreateStatus('  Attending  ')).toBe('Attending');
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
      ['Notes', 'verifying payment'],
      [
        'Personal Data Protection Consent',
        'I hereby acknowledge that I have read and understood…',
      ],
    ]);
    const row = translateEventCreateRow(cells);
    expect(row.isAttending).toBe(true);
    expect(row.attendeeEmail).toBe('lars.svensson@midsummer.se');
    expect(row.attendeeName).toBe('Lars Svensson');
    expect(row.attendeeCompany).toBe('Midsummer AB');
    expect(row.attendeeExternalId).toBe('16940826-1');
    expect(row.ticketType).toBe('SweCham Members');
    expect(row.inferredPaymentStatus).toBe('pending');
    expect(row.pdpaConsentAcknowledged).toBe(true);
  });

  it('treats Status=Cancelled as not Attending (FR-007)', () => {
    const cells = new Map<string, string>([
      ['Status', 'Cancelled'],
      ['First Name', 'Jane'],
      ['Last Name', 'Doe'],
      ['Email', 'jane@example.com'],
    ]);
    expect(translateEventCreateRow(cells).isAttending).toBe(false);
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
