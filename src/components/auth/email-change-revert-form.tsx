'use client';

/**
 * Revert form — F3 FR-012b landing surface (T096 companion).
 *
 * Single-button submission: POSTs the plaintext token to the public
 * revert endpoint. Success → confirmation message + link to /forgot-
 * password so the user completes the required password reset
 * (their account is flagged `requires_password_reset` by the use case).
 *
 * Failure branches:
 *   - 400 `invalid_token`   — generic "link expired or already used"
 *   - 409 `conflict`        — rare; old email unavailable, show detail
 *   - 429 `rate_limited`    — "try again in X seconds"
 *   - 500 `server_error`    — generic retry copy
 *
 * No CSRF token — the public endpoint is protected by origin check +
 * rate limit, and the action is idempotent after the first successful
 * consumption.
 */

import { useState } from 'react';
import { Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

export function EmailChangeRevertForm({ token }: { token: string }) {
  const t = useTranslations('auth.emailChangeRevert');
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });

  async function handleRevert() {
    setState({ kind: 'submitting' });
    try {
      const response = await fetch(
        `/api/auth/email-change/revert/${encodeURIComponent(token)}`,
        { method: 'POST' },
      );
      if (response.ok) {
        setState({ kind: 'success' });
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (response.status === 429) {
        const retry = response.headers.get('retry-after') ?? '60';
        setState({
          kind: 'error',
          message: t('errors.rateLimited', { seconds: retry }),
        });
        return;
      }
      if (response.status === 400) {
        setState({ kind: 'error', message: t('errors.invalidToken') });
        return;
      }
      if (response.status === 409 && body.error === 'conflict') {
        setState({ kind: 'error', message: t('errors.conflict') });
        return;
      }
      setState({ kind: 'error', message: t('errors.serverError') });
    } catch {
      setState({ kind: 'error', message: t('errors.serverError') });
    }
  }

  if (state.kind === 'success') {
    return (
      <div
        className="space-y-4 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4"
        role="status"
        aria-live="polite"
      >
        <p className="text-sm text-emerald-700 dark:text-emerald-300">
          {t('successMessage')}
        </p>
        <a
          href="/forgot-password"
          className="inline-flex items-center text-sm font-medium underline underline-offset-4"
        >
          {t('completePasswordReset')}
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      {state.kind === 'error' ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {state.message}
        </p>
      ) : null}
      <Button
        type="button"
        onClick={handleRevert}
        disabled={state.kind === 'submitting'}
        aria-busy={state.kind === 'submitting'}
        variant="destructive"
        className="w-full"
      >
        {state.kind === 'submitting' ? (
          <>
            <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            {t('submitting')}
          </>
        ) : (
          t('revert')
        )}
      </Button>
    </div>
  );
}
