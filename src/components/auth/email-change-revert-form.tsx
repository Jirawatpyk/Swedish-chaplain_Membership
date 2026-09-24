'use client';

/**
 * Revert form — F3 FR-012b landing surface (T096 companion).
 *
 * Single-button submission: POSTs the plaintext token to the public
 * revert endpoint. Success → confirmation message + link to /forgot-
 * password so the user completes the required password reset
 * (their account is flagged `requires_password_reset` by the use case).
 *
 * Renders the whole card (title, description, body) so the header copy
 * tracks the submit state: the "click below to revert" description only
 * shows while there is a button below to click.
 *
 * Failure branches:
 *   - 400 `invalid_token`   — "link expired or already used"; terminal, so
 *                             the button is replaced by a sign-in link
 *   - 409 `conflict`        — rare; old email unavailable, show detail
 *   - 429 `rate_limited`    — "try again in X seconds"
 *   - 500 `server_error`    — generic retry copy
 *
 * No CSRF token — the public endpoint is protected by origin check +
 * rate limit, and the action is idempotent after the first successful
 * consumption.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { portalSignInPath } from '@/lib/portal-paths';

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success' }
  // 400 invalid_token — the link can never succeed (consumed or past its
  // 48 h TTL), so no retry button is offered.
  | { kind: 'expired' }
  | { kind: 'error'; message: string };

export function EmailChangeRevertForm({ token }: { token: string }) {
  const t = useTranslations('auth.emailChangeRevert');
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });

  // The revert button unmounts on success / expiry — move focus to the region
  // that replaced it so keyboard and screen-reader users are not dropped on
  // <body>.
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.kind === 'success' || state.kind === 'expired') {
      resultRef.current?.focus();
    }
  }, [state.kind]);

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
        setState({ kind: 'expired' });
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

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-2">
        <CardTitle className="text-2xl">{t('title')}</CardTitle>
        {state.kind === 'success' || state.kind === 'expired' ? null : (
          <CardDescription>{t('cardDescription')}</CardDescription>
        )}
      </CardHeader>
      <CardContent>{renderBody()}</CardContent>
    </Card>
  );

  function renderBody() {
    if (state.kind === 'success') {
      return (
        <div
          ref={resultRef}
          tabIndex={-1}
          className="space-y-4 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="status"
          aria-live="polite"
        >
          <p className="text-sm text-emerald-700 dark:text-emerald-300">
            {t('successMessage')}
          </p>
          <p className="text-sm text-muted-foreground">{t('successNextStep')}</p>
          <a
            href="/forgot-password"
            className="inline-flex items-center text-sm font-medium underline underline-offset-4"
          >
            {t('completePasswordReset')}
          </a>
        </div>
      );
    }

    if (state.kind === 'expired') {
      return (
        <div
          ref={resultRef}
          tabIndex={-1}
          className="space-y-4 rounded-md border border-destructive/40 bg-destructive/5 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="alert"
        >
          <p className="text-sm text-destructive">{t('errors.invalidToken')}</p>
          <a
            href={portalSignInPath('member')}
            className="inline-flex h-10 w-full items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
          >
            {t('goToSignIn')}
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
}
