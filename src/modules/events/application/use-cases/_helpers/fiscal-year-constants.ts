/**
 * F6 fiscal-year derivation constants.
 *
 * Centralised here so the 5+ `deriveFiscalYear(event.startDate.toISOString(), 1)`
 * call sites across the F6 events module (archive-event, toggle-event-category,
 * relink-registration, process-attendee-in-tx ×2) stop spelling the literal
 * `1` as a magic number. Surfaces R-S03 from
 * `specs/012-eventcreate-integration/reviews/review-20260516-155013.md`.
 *
 * Why F6 is fixed at January-start (not tenant-configurable like F4
 * invoicing):
 *   - **FR-016** ("System MUST track cultural-event quota per **calendar
 *     year** of the event start date") explicitly anchors event-quota
 *     bookkeeping to the calendar year, not the tenant's fiscal year.
 *   - For SweCham (the first tenant), fiscal-year-start-month == 1 —
 *     so fiscal == calendar and the distinction does not matter today.
 *   - For a future tenant with a non-January fiscal-year start, F6
 *     quota counting MUST still bucket by calendar year so members
 *     reading "Diamond partnership 6 tickets/year" understand "year"
 *     consistently with the rest of their experience (event invitations,
 *     newsletters, etc.). Tying it to a configurable fiscal-year would
 *     create a footgun where two tenants saw different counter resets
 *     for events in the same December–January window.
 *   - F4 invoicing's `tenant_invoice_settings.fiscal_year_start_month`
 *     governs Thai-tax-document numbering buckets (§87/3 retention
 *     boundaries) — a fundamentally different concern from event quota.
 *
 * The `as const` literal-type pin lets TypeScript flow `1` (not `number`)
 * into `deriveFiscalYear`'s second arg, satisfying the
 * `FiscalYearStartMonth = 1 | 2 | ... | 12` union without an explicit
 * `as FiscalYearStartMonth` cast at every call site.
 */
export const F6_FISCAL_YEAR_START_MONTH = 1 as const;
