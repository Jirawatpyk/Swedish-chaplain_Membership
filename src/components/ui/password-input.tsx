'use client';

/**
 * PasswordInput — accessible password field with a reveal toggle (A7).
 *
 * Wraps the shadcn `<Input>` primitive with a right-aligned Eye / EyeOff
 * button that swaps the input `type` between `password` and `text`.
 * The toggle is a 44×44px touch target with localised `aria-label`s,
 * meeting WCAG 2.2 SC 2.5.8 + the ux-standards.md § 15 requirement.
 *
 * Mirrors the API of `<Input>` so callers can drop it in to replace
 * `<Input type="password" />` without other changes. `ref` is forwarded
 * to the underlying input element so react-hook-form's `register` works
 * unmodified.
 */
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export type PasswordInputProps = Omit<
  React.ComponentProps<'input'>,
  'type'
>;

export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ className, ...props }, ref) {
    const t = useTranslations('auth.passwordReveal');
    const [visible, setVisible] = React.useState(false);

    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? 'text' : 'password'}
          // Reserve right-side padding so the toggle icon never overlaps
          // the typed value, even with long values + autofill chrome.
          className={cn('pr-11', className)}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? t('hide') : t('show')}
          aria-pressed={visible}
          // 44×44 target via inline padding to satisfy WCAG 2.2 SC 2.5.8.
          // `inset-y-0` centres vertically; `right-0` keeps it flush.
          className="absolute inset-y-0 right-0 flex h-full w-11 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
          // Toggle button does not submit the parent form.
          tabIndex={0}
        >
          {visible ? (
            <EyeOffIcon className="size-4" aria-hidden />
          ) : (
            <EyeIcon className="size-4" aria-hidden />
          )}
        </button>
      </div>
    );
  },
);
