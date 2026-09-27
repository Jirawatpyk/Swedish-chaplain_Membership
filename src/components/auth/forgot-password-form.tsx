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
import { Alert, Button, FormErrorSummary, TextField } from '@jirawatpyk/aura-react';
import { ArrowLeftIcon } from 'lucide-react';
import { AURA_FOCUS_RING } from '@/components/shell/aura-classes';
import { cn } from '@/lib/utils';
import { AuthTitle } from './auth-title';
import { emailText, type Translator } from '@/lib/zod-i18n';

function buildForgotPasswordSchema(tv: Translator) {
  return z.object({
    email: emailText(tv, 254),
  });
}

type FormValues = z.infer<ReturnType<typeof buildForgotPasswordSchema>>;

const RESEND_COUNTDOWN_SECONDS = 60;

export function ForgotPasswordForm({ signInHref }: { readonly signInHref: string }) {
  const t = useTranslations('auth.forgotPassword');
  const tFrame = useTranslations('auth.frame');
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
  // Managed focus on the sent-state heading so a keyboard/SR user isn't dropped
  // on <body> when the submit button is replaced by the resend row (XF focus).
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

  useEffect(() => {
    setFocus('email');
  }, [setFocus]);

  // Move focus to the sent-state heading when the form swaps to the submitted
  // state (WCAG 2.4.3 — the focused submit button is unmounted), and back to
  // the email field on "Use a different email".
  const wasSubmitted = useRef(false);
  useEffect(() => {
    if (submitted) successRef.current?.focus();
    else if (wasSubmitted.current) setFocus('email');
    wasSubmitted.current = submitted;
  }, [submitted, setFocus]);

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
    await sendRequest(values.email);
  };

  const handleResend = useCallback(async () => {
    const { email } = getValues();
    if (!email) return;
    await sendRequest(email);
  }, [getValues, sendRequest]);

  const linkClass = cn(
    'inline-flex min-h-11 items-center gap-1.5 self-start rounded-[var(--aura-radius-sm)] text-[13px] font-medium text-[var(--aura-fg-accent)] no-underline hover:underline sm:min-h-0',
    AURA_FOCUS_RING,
  );
  const backToSignIn = (
    <a href={signInHref} className={linkClass}>
      <ArrowLeftIcon className="size-4" aria-hidden />
      {tFrame('backToSignIn')}
    </a>
  );

  if (submitted) {
    // The `Auth-forgot` board: "Check your email", the neutral line (it never
    // says whether the email matched — FR-016), a Resend row, the spam hint,
    // then the ways out. The heading block takes focus and is announced.
    return (
      <div className="flex flex-col gap-5">
        <div ref={successRef} tabIndex={-1} role="status" className={cn('rounded-[var(--aura-radius-sm)]', AURA_FOCUS_RING)}>
          <AuthTitle title={t('sentTitle')} description={t('submitted')} />
        </div>
        {/* Gated on errorMsg alone: a failed RESEND happens while submitted===true. */}
        {errorMsg ? <Alert tone="danger">{errorMsg}</Alert> : null}
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span>{t('didntGetIt')}</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleResend}
            disabled={remaining > 0 || submitting}
            loading={submitting}
          >
            {remaining > 0 ? t('resendCountdown', { seconds: remaining }) : t('resend')}
          </Button>
        </div>
        {/* FR-025 — shown to every submitter alike, so it never reveals whether the email matched. */}
        <p className="text-xs text-[var(--aura-fg-secondary)]">{t('deliveryHint')}</p>
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:gap-x-5">
          <button type="button" className={cn(linkClass, 'cursor-pointer border-0 bg-transparent p-0')} onClick={() => setSubmitted(false)}>
            {t('useDifferentEmail')}
          </button>
          {backToSignIn}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <AuthTitle title={t('title')} description={t('description')} />
      <form
        onSubmit={handleSubmit(onSubmit)}
        // Keep the email out of the URL on a pre-hydration native submit
        // (CWE-598; see tests/unit/components/pii-forms-post-method.test.tsx).
        method="post"
        className="flex flex-col gap-5"
        noValidate
      >
        <FormErrorSummary errors={errors} focusKey={submitCount} />

        <TextField
          id="email"
          label={t('emailLabel')}
          type="email"
          inputMode="email"
          autoComplete="username"
          spellCheck={false}
          disabled={submitting}
          error={errors.email?.message}
          {...register('email')}
        />

        {errorMsg ? <Alert tone="danger">{errorMsg}</Alert> : null}

        <Button type="submit" variant="primary" loading={submitting}>
          {t('submit')}
        </Button>
      </form>
      {backToSignIn}
    </div>
  );
}
