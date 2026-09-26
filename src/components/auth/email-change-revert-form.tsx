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
 *
 * Spec 122 US2 (`Auth-revert*` boards): the title is the page's h1 inside
 * `AuthFrame`; AURA alerts carry each outcome (429 is a warning: waiting
 * fixes it) and the buttons are AURA's.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Button, Icon } from '@jirawatpyk/aura-react';
import { AURA_FOCUS_RING } from '@/components/shell/aura-classes';
import { portalSignInPath } from '@/lib/portal-paths';
import { cn } from '@/lib/utils';
import { AuthTitle } from './auth-title';

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success' }
  // 400 invalid_token — the link can never succeed (consumed or past its
  // 48 h TTL), so no retry button is offered.
  | { kind: 'expired' }
  | { kind: 'error'; message: string; tone: 'warning' | 'danger' };

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
          tone: 'warning',
        });
        return;
      }
      if (response.status === 400) {
        setState({ kind: 'expired' });
        return;
      }
      if (response.status === 409 && body.error === 'conflict') {
        setState({ kind: 'error', message: t('errors.conflict'), tone: 'danger' });
        return;
      }
      setState({ kind: 'error', message: t('errors.serverError'), tone: 'danger' });
    } catch {
      setState({ kind: 'error', message: t('errors.serverError'), tone: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <AuthTitle
        title={t('title')}
        description={state.kind === 'success' || state.kind === 'expired' ? undefined : t('cardDescription')}
      />
      {renderBody()}
    </div>
  );

  function renderBody() {
    if (state.kind === 'success') {
      return (
        <div className="flex flex-col gap-6">
          <div
            ref={resultRef}
            tabIndex={-1}
            className={cn('aura-alert aura-alert--success', AURA_FOCUS_RING)}
            role="status"
            aria-live="polite"
          >
            <Icon name="circle-check" className="aura-alert__icon" />
            <div className="aura-alert__body">
              <p className="aura-alert__title">{t('successMessage')}</p>
              <p className="aura-alert__text">{t('successNextStep')}</p>
            </div>
          </div>
          <Button href="/forgot-password" linkComponent="a" variant="primary" icon="arrow-right" fullWidth>
            {t('completePasswordReset')}
          </Button>
        </div>
      );
    }

    if (state.kind === 'expired') {
      return (
        <div ref={resultRef} tabIndex={-1} className={cn('flex flex-col gap-6 rounded-[var(--aura-radius-lg)]', AURA_FOCUS_RING)}>
          <Alert tone="danger">{t('errors.invalidToken')}</Alert>
          <Button href={portalSignInPath('member')} linkComponent="a" variant="primary" icon="arrow-right" fullWidth>
            {t('goToSignIn')}
          </Button>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-6">
        {state.kind === 'error' ? <Alert tone={state.tone}>{state.message}</Alert> : null}
        {/* What reverting does stays beside the button, retry included. AURA
            classes without a role: static text, so no alert on page load. */}
        <div className="aura-alert aura-alert--warning">
          <Icon name="triangle-alert" className="aura-alert__icon" />
          <div className="aura-alert__body">
            <p className="aura-alert__text">{t('description')}</p>
          </div>
        </div>
        <Button
          type="button"
          onClick={handleRevert}
          loading={state.kind === 'submitting'}
          variant="danger"
          fullWidth
        >
          {state.kind === 'submitting' ? t('submitting') : t('revert')}
        </Button>
      </div>
    );
  }
}
