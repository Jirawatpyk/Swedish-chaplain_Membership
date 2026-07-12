'use client';

/**
 * Add / Edit contact dialog (admin member detail page).
 *
 * Wires the `admin.members.contactForm` i18n strings to the contact APIs:
 *   - add  → POST   /api/members/[memberId]/contacts        (addContact)
 *   - edit → PATCH  /api/members/[memberId]/contacts/[id]   (updateContactFields
 *            for non-email fields; the email, when it changed, is routed
 *            server-side — an UNLINKED contact is updated in place via
 *            updateUnlinkedContactEmail, a portal-LINKED contact goes through
 *            the FR-012a atomic flow.)
 *
 * Email editability: always on ADD; on EDIT it is editable for an UNLINKED
 * contact (imported members' contacts have no portal user) and read-only for a
 * portal-LINKED contact, whose sign-in email is changed from the member Edit
 * page (it triggers a verification email). The dialog only sends an `email`
 * field when it actually changed AND the field was editable, and otherwise
 * patches only the non-email fields that changed.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import { uuid } from '@/lib/uuid';
// Deep import (not the members barrel) — pure TS, keeps the E.164 phone
// rule single-sourced with the domain value object.
import { isAcceptablePhoneInput } from '@/modules/members/domain/value-objects/phone';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmailInput } from '@/components/ui/email-input';
import { Label } from '@/components/ui/label';
import { RequiredMark } from '@/components/ui/required-mark';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';



export type ContactInitial = {
  readonly contactId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly roleTitle: string | null;
  readonly preferredLanguage: 'en' | 'th' | 'sv';
  /**
   * Portal user this contact is linked to (null for imported/never-invited
   * contacts). Drives email editability on edit: unlinked → editable in place;
   * linked → read-only (sign-in email, changed via the member Edit page).
   */
  readonly linkedUserId: string | null;
};

type Props = {
  readonly memberId: string;
  readonly mode: 'add' | 'edit';
  /** Required in edit mode — seeds the form + supplies the contactId. */
  readonly contact?: ContactInitial;
  /** Single ReactElement used as the dialog trigger (DialogTrigger render). */
  readonly trigger: React.ReactElement;
};

type FormValues = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  role_title: string;
  preferred_language: 'en' | 'th' | 'sv';
};

export function ContactFormDialog({ memberId, mode, contact, trigger }: Props) {
  const t = useTranslations('admin.members.contactForm');
  const tf = useTranslations('admin.members.create.fields');
  const tA = useTranslations('admin.members.detail.contactActions');
  const tLang = useTranslations('common');
  const tv = useTranslations('shared.validation');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Email is editable on ADD, and on EDIT only for an UNLINKED contact
  // (imported members). A portal-LINKED contact's email is a sign-in identity
  // → read-only here (changed via the member Edit page / FR-012a). Stable for a
  // mounted dialog (mode + linkedUserId never change under it).
  const emailEditable = mode === 'add' || !contact?.linkedUserId;

  const schema = useMemo(() => {
    const phone = z
      .string()
      .max(20, tv('tooLong', { max: 20 }))
      .refine((v) => isAcceptablePhoneInput(v), { message: tf('phoneError') });
    const shape = {
      first_name: z
        .string()
        .trim()
        .min(1, t('fieldRequired'))
        .max(100, tv('tooLong', { max: 100 })),
      last_name: z
        .string()
        .trim()
        .min(1, t('fieldRequired'))
        .max(100, tv('tooLong', { max: 100 })),
      phone,
      role_title: z.string().max(100, tv('tooLong', { max: 100 })),
      preferred_language: z.enum(['en', 'th', 'sv']),
      email: emailEditable
        ? z
            .string()
            .trim()
            .min(1, t('fieldRequired'))
            .max(254, tv('tooLong', { max: 254 }))
            .email(t('emailInvalid'))
        : z.string().optional(),
    };
    return z.object(shape);
    // t/tf/tv are stable per-render; mode/emailEditable never change for a
    // mounted dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, emailEditable]);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      first_name: contact?.firstName ?? '',
      last_name: contact?.lastName ?? '',
      email: contact?.email ?? '',
      phone: contact?.phone ?? '',
      role_title: contact?.roleTitle ?? '',
      preferred_language: contact?.preferredLanguage ?? 'en',
    },
  });

  const handleOpenChange = (next: boolean) => {
    if (next) {
      // Re-seed from the latest props every time the dialog opens so a
      // previous cancelled edit doesn't leave stale values behind.
      reset({
        first_name: contact?.firstName ?? '',
        last_name: contact?.lastName ?? '',
        email: contact?.email ?? '',
        phone: contact?.phone ?? '',
        role_title: contact?.roleTitle ?? '',
        preferred_language: contact?.preferredLanguage ?? 'en',
      });
    }
    setOpen(next);
  };

  const handleError = async (res: Response): Promise<void> => {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; details?: { field?: string } };
    };
    const code = body.error?.code;
    const field = body.error?.details?.field;
    if (res.status === 409 && code === 'conflict' && emailEditable) {
      // Field-level rejection — surface inline on the email input (+ focus)
      // instead of a transient toast (audit XF-01). Only when the email field
      // is editable (add, or an unlinked contact on edit); a read-only email
      // must NOT pin a 409 onto the disabled field (setFocus would no-op).
      setError('email', { type: 'server', message: tA('errors.emailTaken') });
      setFocus('email');
    } else if (res.status === 409 && code === 'conflict') {
      toast.error(tA('errors.emailTaken'));
    } else if (
      res.status === 400 &&
      code === 'validation_error' &&
      field === 'email' &&
      emailEditable
    ) {
      // Server-side email-format rejection on the unlinked in-place path.
      setError('email', { type: 'server', message: t('emailInvalid') });
      setFocus('email');
    } else if (res.status === 400) {
      toast.error(tA('errors.validation'));
    } else if (res.status === 404) {
      toast.error(tA('errors.notFound'));
    } else {
      toast.error(tA('errors.generic'));
    }
  };

  const onSubmit = async (values: FormValues) => {
    setSubmitting(true);
    try {
      if (mode === 'add') {
        const res = await fetch(`/api/members/${memberId}/contacts`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': uuid(),
          },
          body: JSON.stringify({
            first_name: values.first_name.trim(),
            last_name: values.last_name.trim(),
            email: values.email.trim(),
            phone: values.phone.trim() || null,
            role_title: values.role_title.trim() || null,
            preferred_language: values.preferred_language,
          }),
        });
        if (!res.ok) {
          await handleError(res);
          return;
        }
        toast.success(tA('addSuccess'));
      } else {
        // edit — patch only changed fields. `email` is included only when the
        // field is editable (unlinked contact); the route updates it in place.
        const c = contact!;
        const patch: Record<string, unknown> = {};
        if (values.first_name.trim() !== c.firstName)
          patch.first_name = values.first_name.trim();
        if (values.last_name.trim() !== c.lastName)
          patch.last_name = values.last_name.trim();
        if ((values.phone.trim() || null) !== (c.phone ?? null))
          patch.phone = values.phone.trim() || null;
        if ((values.role_title.trim() || null) !== (c.roleTitle ?? null))
          patch.role_title = values.role_title.trim() || null;
        if (values.preferred_language !== c.preferredLanguage)
          patch.preferred_language = values.preferred_language;
        if (emailEditable && values.email.trim() !== c.email)
          patch.email = values.email.trim();

        if (Object.keys(patch).length === 0) {
          setOpen(false);
          return;
        }

        const res = await fetch(
          `/api/members/${memberId}/contacts/${c.contactId}`,
          {
            method: 'PATCH',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': uuid(),
            },
            body: JSON.stringify(patch),
          },
        );
        if (!res.ok) {
          await handleError(res);
          return;
        }
        toast.success(tA('editSuccess'));
      }
      setOpen(false);
      router.refresh();
    } catch {
      toast.error(tA('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <form
          onSubmit={handleSubmit(onSubmit)}
          // Native fallback POSTs so contact name/email/phone (PII) stays out
          // of the URL on a pre-hydration submit (CWE-598; audit XF-03).
          method="post"
          noValidate
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>
              {mode === 'add' ? t('title') : t('editTitle')}
            </DialogTitle>
            <DialogDescription>
              {mode === 'add' ? t('description') : t('editDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="cf-first-name">
                {tf('firstName')} <RequiredMark />
              </Label>
              <Input
                id="cf-first-name"
                autoFocus
                autoComplete="given-name"
                maxLength={100}
                aria-required="true"
                aria-invalid={Boolean(errors.first_name)}
                aria-describedby={errors.first_name ? 'cf-first-name-error' : undefined}
                {...register('first_name')}
              />
              {errors.first_name && (
                <p id="cf-first-name-error" role="alert" className="mt-1 text-xs text-destructive">
                  {errors.first_name.message}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="cf-last-name">
                {tf('lastName')} <RequiredMark />
              </Label>
              <Input
                id="cf-last-name"
                autoComplete="family-name"
                maxLength={100}
                aria-required="true"
                aria-invalid={Boolean(errors.last_name)}
                aria-describedby={errors.last_name ? 'cf-last-name-error' : undefined}
                {...register('last_name')}
              />
              {errors.last_name && (
                <p id="cf-last-name-error" role="alert" className="mt-1 text-xs text-destructive">
                  {errors.last_name.message}
                </p>
              )}
            </div>
          </div>

          <div>
            <Label htmlFor="cf-email">
              {tf('email')}
              {emailEditable && (
                <>
                  {' '}
                  <RequiredMark />
                </>
              )}
            </Label>
            <EmailInput
              id="cf-email"
              maxLength={254}
              // Read-only (not `disabled`) for a linked contact so the field
              // stays focusable — a disabled input is skipped by screen readers
              // in forms mode, which would hide its `aria-describedby` note; it
              // also avoids the disabled `opacity-50` dimming of the address.
              // The PATCH already guards on `emailEditable`, so no value leaks.
              readOnly={!emailEditable}
              aria-readonly={!emailEditable ? 'true' : undefined}
              className={!emailEditable ? 'bg-muted/50' : undefined}
              aria-required={emailEditable ? 'true' : undefined}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={
                !emailEditable
                  ? 'cf-email-note'
                  : errors.email
                    ? 'cf-email-error'
                    : undefined
              }
              {...register('email')}
            />
            {!emailEditable ? (
              <p id="cf-email-note" className="mt-1 text-xs text-muted-foreground">
                {t('emailEditNote')}
              </p>
            ) : (
              errors.email && (
                <p id="cf-email-error" role="alert" className="mt-1 text-xs text-destructive">
                  {errors.email.message}
                </p>
              )
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="cf-phone">{tf('phone')}</Label>
              <Input
                id="cf-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={20}
                placeholder="+66812345678"
                aria-invalid={Boolean(errors.phone)}
                aria-describedby={errors.phone ? 'cf-phone-error' : undefined}
                {...register('phone')}
              />
              {errors.phone && (
                <p id="cf-phone-error" role="alert" className="mt-1 text-xs text-destructive">
                  {errors.phone.message}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="cf-role">{tf('roleTitle')}</Label>
              <Input
                id="cf-role"
                autoComplete="organization-title"
                maxLength={100}
                {...register('role_title')}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="cf-language">{tf('preferredLanguage')}</Label>
            <Controller
              control={control}
              name="preferred_language"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="cf-language" className="w-full">
                    <TranslatedSelectValue
                      placeholder={tLang('languageOptions.en')}
                      translate={(value) =>
                        tLang(`languageOptions.${value as 'en' | 'th' | 'sv'}`)
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">{tLang('languageOptions.en')}</SelectItem>
                    <SelectItem value="th">{tLang('languageOptions.th')}</SelectItem>
                    <SelectItem value="sv">{tLang('languageOptions.sv')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && (
                <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
              )}
              {submitting ? t('submitting') : t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
