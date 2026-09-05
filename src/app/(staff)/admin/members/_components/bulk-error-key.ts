/**
 * 108 PR-B (T041 round 4, F4-#5) — map a bulk-route error body to the i18n key
 * under `admin.members.bulk.errors`. Pure; the bar passes `t.has`.
 */
export type BulkErrorBody = {
  readonly error?: {
    readonly code?: string;
    readonly details?: { readonly code?: string };
  };
};

export function bulkErrorKey(
  body: BulkErrorBody | undefined,
  has: (key: string) => boolean,
): string | null {
  const code = body?.error?.code;
  if (typeof code !== 'string') return null;
  // A refused bulk unarchive names WHY under `details.code`; the one code
  // with a different remedy (restore that member from its own page so a
  // primary can be chosen) gets its own copy.
  if (code === 'state_error' && body?.error?.details?.code === 'no_primary_contact') {
    const specific = 'errors.no_primary_contact';
    if (has(specific)) return specific;
  }
  const key = `errors.${code}`;
  return has(key) ? key : null;
}
