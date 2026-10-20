/**
 * Spec 122 US12c-1 (parity, 20 Oct; board `Admin-broadcast-review-mobile`) —
 * how long an E-Blast has sat in its stage, for the phone bar's status line
 * ("17 hours in stage"): whole minutes under an hour, whole hours under two
 * days, whole days after, in the viewer's language. Rendered once on the
 * server, so the line never re-renders under a live region.
 */
export function formatStageDuration(enteredAt: Date, now: Date, locale: string): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - enteredAt.getTime()) / 60_000));
  const [value, unit] =
    minutes < 60 ? [minutes, 'minute'] : minutes < 48 * 60 ? [Math.floor(minutes / 60), 'hour'] : [Math.floor(minutes / 1440), 'day'];
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value);
}
