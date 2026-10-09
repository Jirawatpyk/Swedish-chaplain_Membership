/**
 * 122 US9a (T906) — sample data for the events list and event detail
 * previews (boards `Admin-events`, `Admin-event-detail`, each with
 * `-mobile`). Every value is invented.
 */
import type { EventsListTableRow } from '@/components/events/events-list-table';
import type { AttendeeRow } from '@/components/events/attendee-table';
import type { ErasureResultRow } from '@/components/events/erasure-results-table';
import type { CsvImportHistoryRow } from '@/components/events/csv-import-history-table';
import { asEventId } from '@/modules/events/domain/branded-types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const EVENT_ROWS: EventsListTableRow[] = [
  { eventId: asEventId(id(901)), name: 'SweCham Crayfish Party 2026 (Kräftskiva)', startDate: '2026-09-05T11:00:00Z', category: 'Networking', totalRegistrations: 148, matchedRegistrations: 121, matchRatePct: 81.8, isPartnerBenefit: true, isCulturalEvent: true, archivedAt: null },
  { eventId: asEventId(id(902)), name: 'Business Breakfast: Thai–Swedish Trade Outlook', startDate: '2026-08-21T01:30:00Z', category: 'Seminar', totalRegistrations: 62, matchedRegistrations: 41, matchRatePct: 66.1, isPartnerBenefit: true, isCulturalEvent: false, archivedAt: null },
  { eventId: asEventId(id(903)), name: 'Midsummer Celebration 2026', startDate: '2026-06-20T10:00:00Z', category: 'Cultural', totalRegistrations: 210, matchedRegistrations: 88, matchRatePct: 41.9, isPartnerBenefit: false, isCulturalEvent: true, archivedAt: null },
  { eventId: asEventId(id(904)), name: 'Young Professionals Afterwork', startDate: '2026-05-14T11:30:00Z', category: 'Networking', totalRegistrations: 37, matchedRegistrations: 30, matchRatePct: 81.1, isPartnerBenefit: false, isCulturalEvent: false, archivedAt: null },
  { eventId: asEventId(id(905)), name: 'Lucia Concert 2025', startDate: '2025-12-13T11:00:00Z', category: 'Cultural', totalRegistrations: 0, matchedRegistrations: 0, matchRatePct: 0, isPartnerBenefit: false, isCulturalEvent: true, archivedAt: '2026-01-10T03:00:00Z' },
];

export const EVENT_ID = asEventId(id(901));

export const EVENT_DETAIL = {
  eventId: EVENT_ID,
  name: 'SweCham Crayfish Party 2026 (Kräftskiva)',
  startDate: '2026-09-05T11:00:00Z',
  category: 'Networking',
  totalRegistrations: 148,
  matchedRegistrations: 121,
  matchRatePct: 81.8,
  isPartnerBenefit: true,
  isCulturalEvent: true,
  archivedAt: null as string | null,
  eventcreateUrl: 'https://www.eventcreate.com/e/swecham-crayfish-2026',
  lastUpdatedAt: '2026-09-24T07:05:00Z',
};

function attendee(n: number, row: Omit<AttendeeRow, 'registrationId' | 'currentMatchedMemberId' | 'isPseudonymised'> & Partial<AttendeeRow>): AttendeeRow {
  return {
    registrationId: id(950 + n) as AttendeeRow['registrationId'],
    currentMatchedMemberId: null,
    isPseudonymised: false,
    ...row,
  };
}

export const ATTENDEE_ROWS: AttendeeRow[] = [
  attendee(1, { attendeeName: 'Erik Johansson', attendeeEmail: 'erik@siamnordic.example' as AttendeeRow['attendeeEmail'], attendeeCompany: 'Siam Nordic Trading Co., Ltd.', matchType: 'member_contact', ticketType: 'Member ticket', ticketPriceThb: null, paymentStatus: 'paid', countedAgainstPartnership: false, countedAgainstCulturalQuota: true, isOverQuota: false, registeredAt: '2026-08-12T03:14:00Z', currentMatchedMemberId: id(3) as AttendeeRow['currentMatchedMemberId'] }),
  attendee(2, { attendeeName: 'Karin Lund', attendeeEmail: 'karin@andamanmarine.example' as AttendeeRow['attendeeEmail'], attendeeCompany: 'Andaman Marine Tech Co., Ltd.', matchType: 'member_domain', ticketType: 'Partner ticket', ticketPriceThb: 1500, paymentStatus: 'paid', countedAgainstPartnership: true, countedAgainstCulturalQuota: false, isOverQuota: false, registeredAt: '2026-08-14T02:02:00Z', currentMatchedMemberId: id(4) as AttendeeRow['currentMatchedMemberId'] }),
  attendee(3, { attendeeName: 'Ploy Rattanakul', attendeeEmail: 'ploy.r@gmail.example' as AttendeeRow['attendeeEmail'], attendeeCompany: 'Siam Nordic Trading', matchType: 'member_fuzzy', ticketType: 'Member ticket', ticketPriceThb: null, paymentStatus: 'paid', countedAgainstPartnership: false, countedAgainstCulturalQuota: false, isOverQuota: true, registeredAt: '2026-08-20T09:45:00Z', currentMatchedMemberId: id(3) as AttendeeRow['currentMatchedMemberId'] }),
  attendee(4, { attendeeName: 'Pimchanok W.', attendeeEmail: 'pim.w@hotmail.example' as AttendeeRow['attendeeEmail'], attendeeCompany: null, matchType: 'unmatched', ticketType: 'Guest ticket', ticketPriceThb: null, paymentStatus: 'pending', countedAgainstPartnership: false, countedAgainstCulturalQuota: false, isOverQuota: false, registeredAt: '2026-09-02T14:30:00Z' }),
  attendee(5, { attendeeName: 'Lars Berg', attendeeEmail: 'lars@nordicdive.example' as AttendeeRow['attendeeEmail'], attendeeCompany: 'Nordic Dive Phuket', matchType: 'non_member', ticketType: 'Guest ticket', ticketPriceThb: 2200, paymentStatus: 'refunded', countedAgainstPartnership: false, countedAgainstCulturalQuota: false, isOverQuota: false, registeredAt: '2026-09-03T01:11:00Z' }),
  attendee(6, { attendeeName: 'Attendee 7f3a', attendeeEmail: 'erased-7f3a@redacted.invalid' as AttendeeRow['attendeeEmail'], attendeeCompany: null, matchType: 'non_member', ticketType: null, ticketPriceThb: null, paymentStatus: 'free', countedAgainstPartnership: false, countedAgainstCulturalQuota: false, isOverQuota: false, registeredAt: '2026-07-01T04:00:00Z', isPseudonymised: true }),
];

/** The relink dialog's member search answers (`/api/admin/members/search`). */
export const MEMBER_SEARCH_HITS = [
  { memberId: id(3), companyName: 'Siam Nordic Trading Co., Ltd.', primaryContactName: 'Erik Johansson' },
  { memberId: id(5), companyName: 'Siam Paper & Pulp Co., Ltd.', primaryContactName: 'Somchai Prasert' },
  { memberId: id(6), companyName: 'Siam Scandinavian Foods', primaryContactName: null },
];

/** 122 US9b-1 (T928) — the erase-by-email results for `ploy.r@gmail.example`. */
export const ERASURE_EMAIL = 'ploy.r@gmail.example';
export const ERASURE_ROWS: ErasureResultRow[] = [
  { registrationId: id(941), eventId: EVENT_ID, eventName: 'SweCham Crayfish Party 2026', dateLabel: '2026-09-05', attendeeName: 'Ploy Rattanakul', matchType: 'member_fuzzy', quota: 'none', isPseudonymised: false },
  { registrationId: id(942), eventId: id(902), eventName: 'Nordic Business Breakfast — Bangkok', dateLabel: '2026-06-18', attendeeName: 'Ploy Rattanakul', matchType: 'member_contact', quota: 'partnership', isPseudonymised: false },
  { registrationId: id(943), eventId: id(903), eventName: 'Midsummer Celebration 2026', dateLabel: '2026-06-20', attendeeName: 'Ploy Rattanakul', matchType: 'member_contact', quota: 'cultural', isPseudonymised: false },
  { registrationId: id(944), eventId: id(904), eventName: null, dateLabel: null, attendeeName: 'Attendee 7f3a', matchType: 'non_member', quota: 'none', isPseudonymised: true },
];

/** 122 US9b-2 (T939) — the CSV import's event list (`/api/admin/events`). */
export const IMPORT_PICKER_EVENTS = EVENT_ROWS.filter((e) => e.archivedAt === null).map((e) => ({
  eventId: e.eventId as string,
  name: e.name,
  startDate: e.startDate,
}));

function historyRow(
  n: number,
  row: Pick<CsvImportHistoryRow, 'uploadedAtDisplay' | 'sourceFormat' | 'originalFilename' | 'outcome' | 'errorCsvAvailable'> & {
    readonly processed: number;
    readonly skipped: number;
    readonly failed: number;
  },
): CsvImportHistoryRow {
  return {
    recordId: id(960 + n),
    uploadedAt: '2026-09-24T07:05:00Z',
    uploadedAtDisplay: row.uploadedAtDisplay,
    sourceFormat: row.sourceFormat,
    originalFilename: row.originalFilename,
    originalSizeBytes: 48_213,
    counts: {
      total: row.processed + row.skipped + row.failed,
      processed: row.processed,
      alreadyImported: 0,
      skipped: row.skipped,
      failed: row.failed,
    },
    outcome: row.outcome,
    durationMs: 4280,
    errorCsvAvailable: row.errorCsvAvailable,
    errorCsvExpiresAt: null,
  };
}

/** 122 US9b-2 (T939) — the CSV import history (board `Admin-events-import-history`). */
export const IMPORT_HISTORY_ROWS: CsvImportHistoryRow[] = [
  historyRow(1, { uploadedAtDisplay: '24 Sep 2026, 14:05', sourceFormat: 'eventcreate_csv', originalFilename: 'swecham-crayfish-party-2026.csv', outcome: 'completed', processed: 146, skipped: 2, failed: 0, errorCsvAvailable: false }),
  historyRow(2, { uploadedAtDisplay: '22 Aug 2026, 09:40', sourceFormat: 'generic_csv', originalFilename: 'business-breakfast-trade-outlook.csv', outcome: 'partial_failure', processed: 58, skipped: 1, failed: 3, errorCsvAvailable: true }),
  historyRow(3, { uploadedAtDisplay: '22 Jun 2026, 11:10', sourceFormat: 'eventcreate_csv', originalFilename: 'midsummer-celebration-2026-attendees.csv', outcome: 'completed', processed: 208, skipped: 0, failed: 2, errorCsvAvailable: false }),
  historyRow(4, { uploadedAtDisplay: '15 May 2026, 18:22', sourceFormat: 'generic_csv', originalFilename: 'yp-afterwork-may.csv', outcome: 'invalid_header', processed: 0, skipped: 0, failed: 0, errorCsvAvailable: false }),
];
