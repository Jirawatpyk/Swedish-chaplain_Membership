/**
 * Renewals client helper — read `error.code` off a non-2xx JSON body.
 *
 * Shared by the renewals inline-mutation client components
 * (`_components/pending-review-list`, `[cycleId]/_components/pending-reactivation-actions`),
 * which each carried an identical inline copy.
 *
 * A malformed/empty body — or an absent `error.code` — resolves to the STRING
 * `'server_error'` (never `undefined`): the callers `===`-compare the result
 * against known codes and build a `reject.error.<code>` i18n-key lookup from it,
 * so the return MUST stay a `string`.
 *
 * This differs DELIBERATELY from `@/components/directory/read-error-code`, whose
 * generic variant resolves to `undefined` on a malformed body — do not swap one
 * for the other.
 */
export async function readErrorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string } };
    return body.error?.code ?? 'server_error';
  } catch {
    return 'server_error';
  }
}
