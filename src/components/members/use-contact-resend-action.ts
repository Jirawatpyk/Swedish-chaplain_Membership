'use client';

/**
 * useContactResendAction — shared fetch + toast + router.refresh pattern
 * for resend-action buttons on the member detail page.
 *
 * Fix 5: on the success path the submitting state is NOT reset (button stays
 * disabled while the RSC router.refresh() is in-flight, preventing a double-
 * click from wasting a rate-limit token). setSubmitting(false) is only called
 * on error paths.
 *
 * Fix 10: extracts the near-identical handler logic from
 * ResendVerificationButton and ResendBouncedInviteButton so the 429/error
 * mapping is caller-supplied. The `on429` handler is OPTIONAL so a button
 * whose API route has no rate-limit (bounced invite) does not need to reference
 * a missing i18n key.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Body = { error?: string; reason?: string };

export interface ContactResendActionOptions {
  /** Full URL to POST to, e.g. `/api/members/${memberId}/contacts/${contactId}/resend-invite`. */
  readonly url: string;
  /** Called on HTTP 200 OK — show success toast (caller owns the i18n key). */
  readonly onSuccess: (body: Body) => void;
  /**
   * Called on HTTP 429 Too Many Requests.
   * OMIT for routes that have no rate-limit (bounced invite) so no missing-key
   * MISSING_MESSAGE error is triggered.
   */
  readonly on429?: (() => void) | undefined;
  /**
   * Called for any non-ok, non-429 response.
   * Receives the parsed body so the caller can branch on `error` / `reason`.
   */
  readonly onError: (body: Body) => void;
}

export interface ContactResendActionReturn {
  readonly submitting: boolean;
  readonly handleClick: () => Promise<void>;
}

export function useContactResendAction(
  opts: ContactResendActionOptions,
): ContactResendActionReturn {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function handleClick(): Promise<void> {
    setSubmitting(true);
    try {
      const response = await fetch(opts.url, { method: 'POST' });

      if (response.ok) {
        // Fix 5 — do NOT reset submitting on success; button stays disabled
        // until the component is unmounted/hidden after router.refresh().
        const body = (await response.json().catch(() => ({}))) as Body;
        opts.onSuccess(body);
        router.refresh();
        // intentionally no setSubmitting(false) here
        return;
      }

      if (response.status === 429 && opts.on429) {
        opts.on429();
        setSubmitting(false);
        return;
      }

      const body = (await response.json().catch(() => ({}))) as Body;
      opts.onError(body);
      setSubmitting(false);
    } catch {
      // Network / JSON-parse failure — delegate to onError with an empty body.
      opts.onError({});
      setSubmitting(false);
    }
  }

  return { submitting, handleClick };
}
