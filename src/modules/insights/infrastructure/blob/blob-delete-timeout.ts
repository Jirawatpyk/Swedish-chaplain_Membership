/**
 * #710 — the bound on one Vercel Blob `del` from the insights module (logo and
 * private export artefacts). The same 10 s as the invoicing and broadcasts
 * Blob deletes: a hung call must not hold the member-erasure route past its
 * `maxDuration`.
 */
export const INSIGHTS_BLOB_DELETE_TIMEOUT_MS = 10_000;
