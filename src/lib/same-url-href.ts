/**
 * PR Q review round 1b — the href of a load error's "Try again" link: the same
 * page with the same query, so a retry keeps the member's filters, page or
 * resubmit id. `undefined` params are left out; a repeated param keeps its order.
 */
export function sameUrlHref(
  path: string,
  params: Readonly<Record<string, string | readonly string[] | undefined>> = {},
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const one of typeof value === 'string' ? [value] : value) query.append(key, one);
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}
