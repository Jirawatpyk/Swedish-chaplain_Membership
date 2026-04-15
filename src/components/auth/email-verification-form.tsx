'use client';

/**
 * Email-verification form — F3 FR-012a landing.
 *
 * Auto-submits on mount (the user clicks the email link and expects
 * verification to just complete). An explicit retry button covers the
 * 5-minute activation-delay case + transient rate-limit.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

type SubmitState =
  | { kind: 'submitting' }
  | { kind: 'success' }
  | { kind: 'error'; code: 'invalid' | 'not_yet_active' | 'rate_limited' | 'server'; retrySeconds?: number };

export function EmailVerificationForm({ token }: { token: string }) {
  const t = useTranslations('auth.emailVerification');
  const [state, setState] = useState<SubmitState>({ kind: 'submitting' });
  const attempted = useRef(false);

  async function submit() {
    setState({ kind: 'submitting' });
    try {
      const response = await fetch(
        `/api/auth/email-verification/${encodeURIComponent(token)}`,
        { method: 'POST' },
      );
      if (response.ok) {
        setState({ kind: 'success' });
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        retryAfterSeconds?: number;
      };
      if (response.status === 429) {
        const retry = Number(response.headers.get('retry-after') ?? 60);
        setState({ kind: 'error', code: 'rate_limited', retrySeconds: retry });
        return;
      }
      if (response.status === 400 && body.error === 'not_yet_active') {
        const retry =
          typeof body.retryAfterSeconds === 'number'
            ? body.retryAfterSeconds
            : 300;
        setState({ kind: 'error', code: 'not_yet_active', retrySeconds: retry });
        return;
      }
      if (response.status === 400) {
        setState({ kind: 'error', code: 'invalid' });
        return;
      }
      setState({ kind: 'error', code: 'server' });
    } catch {
      setState({ kind: 'error', code: 'server' });
    }
  }

  // One-shot auto-submit on mount. Wrapped in queueMicrotask so the
  // setState inside submit() lands OUTSIDE the render pass, avoiding
  // the react-compiler "cascading renders" warning. `attempted` ref
  // guards against React 19 strict-mode double-invocation.
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    queueMicrotask(() => {
      void submit();
    });
    // submit is stable for this component's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.kind === 'submitting') {
    return (
      <p
        className="text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        {t('verifying')}
      </p>
    );
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
          href="/admin"
          className="inline-flex items-center text-sm font-medium underline underline-offset-4"
        >
          {t('signInCta')}
        </a>
      </div>
    );
  }

  const errorMessage =
    state.code === 'not_yet_active'
      ? t('errors.notYetActive', { seconds: state.retrySeconds ?? 300 })
      : state.code === 'rate_limited'
        ? t('errors.rateLimited', { seconds: state.retrySeconds ?? 60 })
        : state.code === 'invalid'
          ? t('errors.invalidToken')
          : t('errors.serverError');

  return (
    <div className="space-y-4">
      <p
        className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        role="alert"
      >
        {errorMessage}
      </p>
      {state.code !== 'invalid' ? (
        <Button type="button" onClick={submit} className="w-full">
          {t('retry')}
        </Button>
      ) : null}
    </div>
  );
}
