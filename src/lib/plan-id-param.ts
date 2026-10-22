/**
 * 124 — the `?plan=<plan_id>` URL value, shared by the admin invoice list
 * (`src/app/(staff)/admin/invoices/_lib/plan-filter.ts`) and the invoice
 * dashboard's filter parser (`@/modules/insights` domain), so a dashboard
 * figure and the list it drills into accept exactly the same ids (spec US2:
 * the list count equals the figure). Any well-formed id filters (D-i); empty
 * or over-long values are IGNORED. The 64 matches the list use case's zod
 * `planId` bound. Pure, client-safe.
 */
const MAX_PLAN_ID_LENGTH = 64;

/** The `?plan=` value to filter by, or undefined when it is ignored. */
export function parsePlanIdParam(raw: string | undefined): string | undefined {
  return raw && raw.length <= MAX_PLAN_ID_LENGTH ? raw : undefined;
}
