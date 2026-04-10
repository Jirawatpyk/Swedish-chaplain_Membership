'use client';

/**
 * SignInForm — credentials entry for staff and member portals (T072).
 *
 * Uses react-hook-form + zod for client-side validation and shadcn
 * Input/Label/Button for consistent styling. The shadcn `form` wrapper
 * is no longer in the registry under base-nova; we compose RHF
 * primitives directly.
 *
 * UX requirements (spec FR-024 + ux-standards § 8 + § 11):
 *   - Email field has auto-focus on mount
 *   - Enter submits the form
 *   - Submit button shows in-place spinner state
 *   - Inline error messages localised via next-intl
 *   - On submission failure, focus moves to the first invalid field
 *     (or the email if the failure is "invalid-credentials")
 *   - All toasts are routed through `sonner` (see RootLayout)
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { zodResolver } from '@hookform/resolvers/zod';
import { type SubmitHandler, useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { safeReturnTo } from '@/lib/return-url';

const schema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

type FormValues = z.infer<typeof schema>;

export interface SignInFormProps {
  readonly portal: 'staff' | 'member';
  /**
   * Optional validated return path from the sign-in page's server
   * component. Server-side validation via `safeReturnTo()` has already
   * run; we re-validate client-side as defense-in-depth.
   */
  readonly returnTo?: string | null;
}

export function SignInForm({ portal, returnTo }: SignInFormProps) {
  const t = useTranslations('auth.signIn');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
    mode: 'onSubmit',
  });

  // Auto-focus the email field on mount (spec FR-024 primary-input table).
  useEffect(() => {
    setFocus('email');
  }, [setFocus]);

  const onSubmit: SubmitHandler<FormValues> = async (values) => {
    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/sign-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, portal }),
      });

      if (response.ok) {
        const data = (await response.json()) as { redirect: string };
        // Re-validate returnTo client-side before navigation (defense
        // in depth — the server already validated via safeReturnTo in
        // the sign-in page's server component, but we re-check here
        // so any future refactor that forgets the guard still stays
        // safe).
        const safeReturn = returnTo ? safeReturnTo(returnTo, portal) : null;
        router.push(safeReturn ?? data.redirect);
        router.refresh();
        return;
      }

      const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
      const errorCode = errorBody.error ?? 'invalid-credentials';

      switch (errorCode) {
        case 'account-disabled':
          toast.error(t('errors.accountDisabled'));
          break;
        case 'account-locked':
          toast.error(t('errors.accountLocked'));
          break;
        case 'rate-limited':
          toast.error(t('errors.rateLimited'));
          break;
        case 'invalid-credentials':
        default:
          // Same generic message as the API — never reveal which field
          // was wrong (spec FR-016).
          setError('root', { message: t('errors.invalidCredentials') });
          setFocus('email');
          break;
      }
    } catch {
      toast.error(tErrors('network'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="space-y-4"
      noValidate
      aria-busy={submitting}
    >
      <div className="space-y-2">
        <Label htmlFor="email">{t('emailLabel')}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          spellCheck={false}
          aria-invalid={errors.email ? 'true' : undefined}
          {...register('email')}
        />
        {errors.email ? (
          <p className="text-sm text-destructive">{errors.email.message}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">{t('passwordLabel')}</Label>
          <a
            href="/forgot-password"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            {t('forgotPassword')}
          </a>
        </div>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={errors.password ? 'true' : undefined}
          {...register('password')}
        />
        {errors.password ? (
          <p className="text-sm text-destructive">{errors.password.message}</p>
        ) : null}
      </div>

      {errors.root ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {errors.root.message}
        </div>
      ) : null}

      <Button type="submit" className="w-full" size="lg" disabled={submitting}>
        {submitting ? (
          <>
            <Loader2Icon className="size-4 animate-spin" aria-hidden />
            {t('submitting')}
          </>
        ) : (
          t('submit')
        )}
      </Button>
    </form>
  );
}
