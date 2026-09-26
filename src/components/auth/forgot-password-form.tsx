'use client';

/**
 * ForgotPasswordForm (T103, spec US3 AS1, FR-024 / FR-025).
 *
 * UX:
 *   - Email field auto-focused on mount (FR-024 primary-input rule).
 *   - On submit, the form shows the neutral "if the email is
 *     registered, a link has been sent" message — NEVER distinguishes
 *     between known and unknown emails (FR-016 enumeration guard).
 *   - After submission, a 60-second countdown gates the resend
 *     affordance (FR-025 / SC-017). Until the countdown expires, the
 *     resend link is disabled and shows the remaining seconds.
 *   - Failures (429 rate-limit / non-ok / network) surface an inline
 *     role="alert" banner above the form (never a toast — see
 *     ux-standards § 4.1), on both the first submit and a resend.
 *   - Keyboard: Enter submits. Esc is a no-op (spec explicitly does
 *     NOT want Esc to clear the form since that is surprising).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { zodResolver } from '@hookform/resolvers/zod';
import { type SubmitHandler, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert, Button, FormErrorSummary, Icon, TextField } from '@jirawatpyk/aura-react';
import { AURA_FOCUS_RING } from '@/components/shell/aura-classes';
import { cn } from '@/lib/utils';
import { emailText, type Translator } from '@/lib/zod-i18n';
import { useSubmittedErrors } from './use-submitted-errors';

function buildForgotPasswordSchema(tv: Translator) {
  return z.object({
    email: emailText(tv, 254),
  });
}

type FormValues = z.infer<ReturnType<typeof buildForgotPasswordSchema>>;

const RESEND_COUNTDOWN_SECONDS = 60;

export function ForgotPasswordForm() {
  const t = useTranslations('auth.forgotPassword');
  const tErrors = useTranslations('errors');
  const tv = useTranslations('shared.validation');
  // Email-locale audit 2026-07-16 — the reset email must arrive in the language
  // the requester is using (requester = recipient, so the active UI locale is
  // the right signal). The API already accepts an optional `locale`; the form
  // just never sent it, so every reset email shipped English.
  const locale = useLocale();
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Managed focus on the success card so a keyboard/SR user isn't dropped on
  // <body> when the submit button is replaced by the resend button (XF focus).
  const successRef = useRef<HTMLDivElement>(null);

  const schema = useMemo(
    () => buildForgotPasswordSchema(tv as Translator),
    [tv],
  );

  const {
    register,
    handleSubmit,
    setFocus,
    getValues,
    formState: { errors, submitCount },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
    mode: 'onSubmit',
    // The error summary takes focus after a failed submit (spec 122 US2 AS1).
    shouldFocusError: false,
  });
  const summary = useSubmittedErrors<FormValues>();

  useEffect(() => {
    setFocus('email');
  }, [setFocus]);

  // Move focus to the success card when the form swaps to the submitted state
  // (WCAG 2.4.3 — the focused submit button is unmounted).
  useEffect(() => {
    if (submitted) successRef.current?.focus();
  }, [submitted]);

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
    },
    [],
  );

  const startCountdown = useCallback(() => {
    setRemaining(RESEND_COUNTDOWN_SECONDS);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setRemaining((previous) => {
        if (previous <= 1) {
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          return 0;
        }
        return previous - 1;
      });
    }, 1000);
  }, []);

  const sendRequest = useCallback(
    async (email: string) => {
      setSubmitting(true);
      setErrorMsg(null);
      try {
        const response = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, locale }),
        });
        if (response.status === 429) {
          // Actionable rate-limit copy instead of a generic "went wrong".
          setErrorMsg(t('rateLimited'));
          return;
        }
        if (!response.ok) {
          setErrorMsg(tErrors('generic'));
          return;
        }
        setSubmitted(true);
        startCountdown();
      } catch {
        setErrorMsg(tErrors('network'));
      } finally {
        setSubmitting(false);
      }
    },
    [startCountdown, t, tErrors, locale],
  );

  const onSubmit: SubmitHandler<FormValues> = async (values) => {
    summary.clear();
    await sendRequest(values.email);
  };

  const handleResend = useCallback(async () => {
    const { email } = getValues();
    if (!email) return;
    await sendRequest(email);
  }, [getValues, sendRequest]);

  return (
    <form
      onSubmit={handleSubmit(onSubmit, summary.onInvalid)}
      // Keep the email out of the URL on a pre-hydration native submit
      // (CWE-598; see tests/unit/components/pii-forms-post-method.test.tsx).
      method="post"
      className="flex flex-col gap-4"
      noValidate
    >
      <FormErrorSummary errors={summary.errors} focusKey={submitCount} />

      <TextField
        id="email"
        label={t('emailLabel')}
        type="email"
        inputMode="email"
        autoComplete="username"
        spellCheck={false}
        disabled={submitting || submitted}
        error={errors.email?.message}
        {...register('email')}
      />

      {/* Gated on errorMsg alone (NOT `!submitted`): a failed RESEND happens
        * while submitted===true, so `!submitted` would swallow it. Each send
        * clears errorMsg first (setErrorMsg(null)), so the success path leaves
        * it null and the banner stays hidden; only a real failure shows it. */}
      {errorMsg ? <Alert tone="danger">{errorMsg}</Alert> : null}

      {submitted ? (
        // AURA's success alert, drawn from its classes: it takes focus when the
        // submit button it replaces unmounts, which `Alert` cannot (no tabIndex).
        <div
          ref={successRef}
          tabIndex={-1}
          className={cn('aura-alert aura-alert--success', AURA_FOCUS_RING)}
          role="status"
        >
          <Icon name="circle-check" className="aura-alert__icon" />
          <div className="aura-alert__body">
            <p className="aura-alert__text">{t('submitted')}</p>
            {/* FR-025 user-facing advisory — shown UNCONDITIONALLY (to matched
                and unmatched submitters alike) so it never reveals whether the
                email matched an account (preserves the FR-016 enumeration guard),
                while still helping a real user whose mail was delayed/spam-filed. */}
            <p className="aura-alert__text text-[var(--aura-fg-secondary)]">{t('deliveryHint')}</p>
          </div>
        </div>
      ) : null}

      {!submitted ? (
        <div className="flex flex-col pt-2">
          <Button type="submit" variant="primary" loading={submitting}>
            {t('submit')}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="secondary"
          onClick={handleResend}
          disabled={remaining > 0 || submitting}
          loading={submitting}
        >
          {remaining > 0 ? t('resendCountdown', { seconds: remaining }) : t('resend')}
        </Button>
      )}
    </form>
  );
}
