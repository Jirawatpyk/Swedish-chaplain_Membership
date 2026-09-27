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
import { ArrowLeftIcon } from 'lucide-react';
import { Alert, Button } from '@jirawatpyk/aura-react';
import { AURA_FOCUS_RING } from '@/components/shell/aura-classes';
import { portalSignInPath } from '@/lib/portal-paths';
import { cn } from '@/lib/utils';
import { AuthTitle } from './auth-title';

/**
 * How long a revert link works, for the warning copy. The token's TTL is
 * `REVERT_TOKEN_TTL_MS` in the members module (a server file this client
 * component cannot import); a unit test keeps the two equal.
 */
export const REVERT_LINK_HOURS = 48;

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success' }
  // 400 invalid_token — the link can never succeed (consumed or past its
  // 48 h TTL), so no retry button is offered.
  | { kind: 'expired' }
  // 409 — the old address is taken: nothing on this page can fix it.
  | { kind: 'conflict' }
  // 429 — waiting fixes it; the button stays disabled until then.
  | { kind: 'rate-limited'; seconds: number }
  | { kind: 'error' };

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
        const seconds = Number(response.headers.get('retry-after') ?? 60) || 60;
        setState({ kind: 'rate-limited', seconds });
        return;
      }
      if (response.status === 400) {
        setState({ kind: 'expired' });
        return;
      }
      if (response.status === 409 && body.error === 'conflict') {
        setState({ kind: 'conflict' });
        return;
      }
      setState({ kind: 'error' });
    } catch {
      setState({ kind: 'error' });
    }
  }

  // The 429 wait: re-enable the button once the server's retry-after passes.
  const waitSeconds = state.kind === 'rate-limited' ? state.seconds : 0;
  useEffect(() => {
    if (waitSeconds <= 0) return undefined;
    const timer = setTimeout(() => setState({ kind: 'idle' }), waitSeconds * 1000);
    return () => clearTimeout(timer);
  }, [waitSeconds]);

  const showDescription = state.kind === 'idle' || state.kind === 'submitting' || state.kind === 'error' || state.kind === 'rate-limited';
  return (
    <div className="flex flex-col gap-5">
      <AuthTitle title={t('title')} description={showDescription ? t('cardDescription') : undefined} />
      {renderBody()}
    </div>
  );

  function renderBody() {
    if (state.kind === 'success') {
      return (
        <div className="flex flex-col gap-5">
          <Alert ref={resultRef} tabIndex={-1} tone="success" title={t('successMessage')} aria-live="polite" className={AURA_FOCUS_RING}>
            {t('successNextStep')}
          </Alert>
          <Button href="/forgot-password" linkComponent="a" variant="primary" icon="arrow-right" fullWidth>
            {t('completePasswordReset')}
          </Button>
        </div>
      );
    }

    if (state.kind === 'expired') {
      return (
        <div ref={resultRef} tabIndex={-1} className={cn('flex flex-col gap-5 rounded-[var(--aura-radius-lg)]', AURA_FOCUS_RING)}>
          <Alert tone="danger" title={t('errors.invalidToken')}>
            {t('errors.invalidTokenBody')}
          </Alert>
          <Button href={portalSignInPath('member')} linkComponent="a" variant="primary" icon="arrow-right" fullWidth>
            {t('goToSignIn')}
          </Button>
        </div>
      );
    }

    if (state.kind === 'conflict') {
      // The `Auth-revert-errors` board: the alert alone — no retry can help.
      return <Alert tone="danger" title={t('errors.conflict')} />;
    }

    const waiting = state.kind === 'rate-limited';
    return (
      <div className="flex flex-col gap-5">
        {waiting ? <Alert tone="warning" title={t('errors.rateLimited', { seconds: state.seconds })} /> : null}
        {state.kind === 'error' ? <Alert tone="danger" title={t('errors.serverError')} /> : null}
        {/* What reverting does stays beside the button, retry included. Static
            text, so no live role: nothing is announced on page load. */}
        <Alert tone="warning" role="none" title={t('warningTitle')}>
          {t('description', { hours: REVERT_LINK_HOURS })}
        </Alert>
        <div className="flex flex-col gap-3">
          {/* While waiting out a 429 the board draws a disabled primary button. */}
          <Button
            type="button"
            onClick={handleRevert}
            loading={state.kind === 'submitting'}
            disabled={waiting}
            variant={waiting ? 'primary' : 'danger'}
            fullWidth
          >
            {state.kind === 'submitting' ? t('submitting') : t('revert')}
          </Button>
          <a
            href={portalSignInPath('member')}
            className={cn(
              'inline-flex min-h-11 items-center gap-1.5 self-start rounded-[var(--aura-radius-sm)] text-[13px] font-medium text-[var(--aura-fg-accent)] no-underline hover:underline',
              AURA_FOCUS_RING,
            )}
          >
            <ArrowLeftIcon className="size-4" aria-hidden />
            {t('madeThisChange')}
          </a>
        </div>
      </div>
    );
  }
}
