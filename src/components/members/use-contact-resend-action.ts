'use client';

/**
 * useContactResendAction — shared fetch + toast + router.refresh pattern
 * for resend-action buttons on the member detail page.
 *
 * Success-path submitting reset: by DEFAULT `submitting` resets to false on a
 * 200 so a button that stays mounted (its visible-gate did not clear) can be
 * used again. A caller whose gate clears on success — so the component
 * unmounts after router.refresh() — passes `keepDisabledOnSuccess: true` to
 * avoid a brief re-enable flicker before unmount. (DV code-review fix: the
 * verification button's gate does NOT clear on resend — resending only
 * re-issues a token, the email stays unverified — so the old always-no-reset
 * left it stuck disabled showing "Sending…" forever; it could never re-send.)
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
  /**
   * Keep `submitting` true after a 200 success (default: reset to false).
   * Set true ONLY for a button whose visible-gate clears on success so the
   * component unmounts after `router.refresh()` (ResendBouncedInviteButton:
   * the route clears `invite_bounced_at` → the button unmounts) — keeping it
   * disabled avoids a re-enable flicker. A button whose gate does NOT clear
   * (ResendVerificationButton: the email stays unverified, so the button stays
   * mounted) MUST leave this false, else it is stuck disabled "Sending…"
   * forever and can never re-send.
   */
  readonly keepDisabledOnSuccess?: boolean;
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
        const body = (await response.json().catch(() => ({}))) as Body;
        opts.onSuccess(body);
        router.refresh();
        // Reset submitting so a button that stays mounted across the refresh
        // (its visible-gate did not clear) can be used again. Buttons that
        // unmount on success opt out via keepDisabledOnSuccess to avoid a
        // re-enable flicker. (See the option's docstring.)
        if (!opts.keepDisabledOnSuccess) setSubmitting(false);
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
