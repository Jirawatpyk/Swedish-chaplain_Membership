'use client';

/**
 * Email-verification form — F3 FR-012a landing.
 *
 * Auto-submits on mount (the user clicks the email link and expects
 * verification to just complete). An explicit retry button covers the
 * 5-minute activation-delay case + transient rate-limit.
 *
 * Spec 122 US2 (`Auth-verify` boards): AURA `Alert` for the outcome and
 * `Button` for the next step.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Button } from '@jirawatpyk/aura-react';

type SubmitState =
  | { kind: 'submitting' }
  | { kind: 'success' }
  | { kind: 'error'; code: 'invalid' | 'not_yet_active' | 'rate_limited' | 'server'; retrySeconds?: number };

export interface EmailVerificationFormProps {
  readonly token: string;
  /**
   * B9 (post-ship 2026-05-17) — destination after a successful
   * verification. The server page passes `/admin` for staff users +
   * `/portal` for members. Pre-B9 the CTA was hardcoded to `/admin`,
   * which sent member users into the staff portal where the role
   * guard immediately bounced them back to sign-in — a confusing
   * redirect loop.
   */
  readonly redirectTo?: string;
}

export function EmailVerificationForm({
  token,
  redirectTo = '/admin',
}: EmailVerificationFormProps) {
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
      <p className="text-[var(--aura-fg-secondary)]" role="status" aria-live="polite">
        {t('verifying')}
      </p>
    );
  }

  if (state.kind === 'success') {
    return (
      <div className="flex flex-col gap-6">
        {/* AURA's success alert is role="status": announced politely. */}
        <Alert tone="success">{t('successMessage')}</Alert>
        {/* A full page load, as before: the destination re-reads the session. */}
        <Button href={redirectTo} linkComponent="a" variant="primary" icon="arrow-right" fullWidth>
          {t('signInCta')}
        </Button>
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
    <div className="flex flex-col gap-6">
      <Alert tone="danger">{errorMessage}</Alert>
      {state.code !== 'invalid' ? (
        <Button type="button" variant="primary" onClick={submit} fullWidth>
          {t('retry')}
        </Button>
      ) : null}
    </div>
  );
}
