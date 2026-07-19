/** True when any shared key differs between the two flat records. */
export function isDirty(
  initial: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  for (const key of Object.keys(current)) {
    if (!Object.is(initial[key], current[key])) return true;
  }
  return false;
}
