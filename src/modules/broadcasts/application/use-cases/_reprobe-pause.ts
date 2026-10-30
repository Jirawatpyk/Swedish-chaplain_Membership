/**
 * The pause before re-probing a Resend broadcast id that answered not found.
 * Shared by the import leg (`buildAudienceTick`, which re-mints on a second
 * `not_found`) and the erasure cascade (`cancelInFlightBroadcastsForMember`,
 * spec 139 review round 2: between a DELETE 404 and its confirming GET), so
 * the two "two not-founds" rules cannot drift apart.
 *
 * Why it exists: a `not_found` makes `confirmImport` mint a FRESH resource;
 * were that answer a stale or transient 404 for a send Resend in fact
 * accepted, the audience would be mailed twice. GET has answered consistently
 * in every measurement (2026-10-29), but a transient 404 cannot be induced to
 * test it, so the id is declared dead only on a second `not_found`
 * (maintainer, 29 Oct 2026).
 *
 * Pure Application — no framework imports.
 */
export const REPROBE_PAUSE_MS = 3_000;

/** The default pause: a timer. Tests inject a recorder instead. */
export function sleepBeforeReprobe(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
