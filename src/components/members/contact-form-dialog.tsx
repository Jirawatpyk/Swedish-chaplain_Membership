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

import { useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { Button, Checkbox, Dialog, Select, TextField } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { uuid } from '@/lib/uuid';
// Deep import (not the members barrel) — pure TS, keeps the E.164 phone
// rule single-sourced with the domain value object.
import { isAcceptablePhoneInput } from '@/modules/members/domain/value-objects/phone';

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
  /**
   * Whether this is the member's PRIMARY contact. The member Edit page only
   * changes the PRIMARY contact's sign-in email, so a linked SECONDARY contact
   * has no edit path there — its email is editable here (routed through the
   * PATCH linked branch → changeContactEmail / FR-012a).
   */
  readonly isPrimary: boolean;
};

type Props = {
  readonly memberId: string;
  readonly mode: 'add' | 'edit';
  /** Required in edit mode — seeds the form + supplies the contactId. */
  readonly contact?: ContactInitial;
  /** One button that opens the dialog; it gets the click handler. */
  readonly trigger: React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>>;
  /**
   * 108 PR-B — a caller-specific description for ADD mode. The restore
   * dialog opens this form for a member with NO contacts, where the generic
   * "add another person … as a secondary contact" is wrong on both counts:
   * there is no other person, and the first contact becomes the primary.
   */
  readonly description?: string;
  /**
   * 108 PR-B — fires after a successful ADD (never on a refused one), before
   * the router refresh. The restore dialog uses it to restore the member
   * again in place now that a primary exists.
   */
  readonly onSaved?: () => void;
  /**
   * 108 PR-B — refuse to open (the trigger stays focusable; see the restore
   * dialog for why it is `aria-disabled`, not `disabled`). Set while the
   * caller has a request in flight that this form's save would race.
   */
  readonly disabled?: boolean;
};

type FormValues = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  role_title: string;
  preferred_language: 'en' | 'th' | 'sv';
  /**
   * Task 8 (GDPR Art. 14) — ADD mode only. This dialog's "add" path is the
   * second of the two entry points that collect a named third party's data
   * from the admin rather than the person themselves (the other is the
   * create-member secondary-contact section). Not meaningful on EDIT (an
   * existing contact was already attested at creation time — see
   * `Contact.art14AttestedAt`), so the schema only requires/validates it
   * when `mode === 'add'`; always present on `FormValues` so both modes
   * share one `useForm` shape.
   */
  art14_attested: boolean;
};

export function ContactFormDialog({
  memberId,
  mode,
  contact,
  trigger,
  description,
  onSaved,
  disabled = false,
}: Props) {
  const t = useTranslations('admin.members.contactForm');
  const tf = useTranslations('admin.members.create.fields');
  const tA = useTranslations('admin.members.detail.contactActions');
  const tLang = useTranslations('common');
  const tv = useTranslations('shared.validation');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Email is editable on ADD, on EDIT for an UNLINKED contact (imported
  // members), and on EDIT for a linked SECONDARY contact — the member Edit page
  // only changes the PRIMARY contact's sign-in email, so a linked secondary has
  // no other edit path (the PATCH linked branch routes it through the FR-012a
  // atomic change-contact-email flow). Only a linked PRIMARY contact's email is
  // read-only here (a sign-in identity, changed via the member Edit page).
  // Stable for a mounted dialog (mode + linkedUserId + isPrimary never change).
  const emailEditable =
    mode === 'add' || !contact?.linkedUserId || !contact?.isPrimary;

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
      // Task 8 (GDPR Art. 14) — ADD mode only. The admin must attest they
      // informed this third party before the contact can be submitted; an
      // existing (EDIT) contact was already attested at creation time, so no
      // gate here. `z.literal(true)`-equivalent via refine (keeps the field a
      // plain boolean on FormValues for both modes).
      art14_attested:
        mode === 'add'
          ? z
              .boolean()
              .refine((v) => v === true, { message: t('art14AttestationRequired') })
          : z.boolean().optional().transform(() => true),
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
      art14_attested: false,
    },
  });

  const handleOpenChange = (next: boolean) => {
    if (next && disabled) return;
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
        art14_attested: false,
      });
    }
    setOpen(next);
  };

  const handleError = async (res: Response): Promise<void> => {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; details?: { field?: string; reason?: string } };
    };
    const code = body.error?.code;
    const field = body.error?.details?.field;
    const reason = body.error?.details?.reason;
    // 108 PR-B (T041 round 4, F4-#2) — a 409 is about the EMAIL only when the
    // server says so (or predates the reason token). The primacy reasons
    // (`primary_contact_race` / `no_primary_contact`) mean the member's
    // contacts changed under this form; pinning "email already in use" on an
    // address nobody has used would be a lie with no way forward.
    const emailConflict =
      res.status === 409 &&
      code === 'conflict' &&
      (reason === undefined || reason === 'contact_email_in_use');
    if (res.status === 409 && code === 'conflict' && !emailConflict) {
      toast.error(tA('errors.conflict'));
    } else if (emailConflict && emailEditable) {
      // Field-level rejection — surface inline on the email input (+ focus)
      // instead of a transient toast (audit XF-01). Only when the email field
      // is editable (add, or an unlinked contact on edit); a read-only email
      // must NOT pin a 409 onto the disabled field (setFocus would no-op).
      setError('email', { type: 'server', message: tA('errors.emailTaken') });
      setFocus('email');
    } else if (emailConflict) {
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
    } else if (res.status === 503) {
      // Transient Upstash outage (idempotency_reservation_failed + Retry-After):
      // report as retryable, matching the create/edit-member clients — not the
      // permanent-sounding generic error.
      toast.error(tA('errors.serverBusy'));
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
            // Task 8 (GDPR Art. 14) — the schema already blocked submit
            // unless this was checked, so always `true` here; forwarded so
            // the server's own `z.literal(true)` gate sees it.
            art14_attested: values.art14_attested,
          }),
        });
        if (!res.ok) {
          await handleError(res);
          return;
        }
        toast.success(tA('addSuccess'));
        onSaved?.();
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
        if (emailEditable && values.email.trim() !== c.email) {
          patch.email = values.email.trim();
          // `locale` is consumed by changeContactEmail (linked SECONDARY path)
          // to send the verification email in the contact's language; the route
          // defaults to 'en' if absent and strips it on the unlinked in-place
          // path, so sending it always is harmless.
          patch.locale = values.preferred_language;
        }

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
        // A 200 may carry a `field_update_failed` marker (finding 6/8): the
        // route runs the email change and the non-email fields as two txns, so
        // the email can commit while the fields fail. Warn — rather than a plain
        // success toast — so the admin knows the email saved and only the other
        // fields need a retry (retrying replays the same idempotency key → no
        // duplicate email audit).
        const body = (await res.json().catch(() => ({}))) as {
          field_update_failed?: string;
        };
        if (body.field_update_failed) {
          toast.warning(t('partialSave'));
        } else {
          toast.success(tA('editSuccess'));
        }
      }
      setOpen(false);
      // A caller that passed `onSaved` owns the follow-up (the restore dialog
      // restores again, which refreshes once on its own); refreshing here too
      // would re-render the server tree twice (T041 UX round 2, N6c).
      // Keyed on the branch that fired the callback, not on the prop's
      // presence: an EDIT caller that passes `onSaved` keeps its refresh
      // (round 4, F4-#13).
      if (!(mode === 'add' && onSaved)) router.refresh();
    } catch {
      toast.error(tA('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  // The caller's button is AURA's Dialog `trigger` (5.16, handoff 101): AURA
  // wires aria-haspopup / aria-expanded and returns focus to it on close; the
  // open state stays ours (`onOpen`) so each open re-seeds the form and a
  // `disabled` form refuses to open. The form lives in the dialog body and its
  // footer submit is tied to it by `form=` (AURA renders the footer outside
  // the body).
  const formId = useId();
  const languageOptions = (['en', 'th', 'sv'] as const).map((value) => ({
    value,
    label: tLang(`languageOptions.${value}`),
  }));

  return (
    <Dialog
      trigger={trigger}
      open={open}
      onOpen={() => handleOpenChange(true)}
      onClose={() => handleOpenChange(false)}
      // No Escape / scrim close while the save runs.
      dismissible={!submitting}
      title={mode === 'add' ? t('title') : t('editTitle')}
      description={mode === 'add' ? (description ?? t('description')) : t('editDescription')}
      footer={
        <>
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          {/* `loading` alone: AURA marks it aria-disabled and ignores clicks,
              and focus stays on it (a native disabled drops it to <body>). */}
          <Button type="submit" form={formId} loading={submitting}>
            {submitting ? t('submitting') : t('submit')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={handleSubmit(onSubmit)}
        // Native fallback POSTs so contact name/email/phone (PII) stays out
        // of the URL on a pre-hydration submit (CWE-598; audit XF-03).
        method="post"
        noValidate
        className="flex flex-col gap-4"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            id="cf-first-name"
            label={tf('firstName')}
            required
            autoComplete="given-name"
            maxLength={100}
            error={errors.first_name?.message}
            {...register('first_name')}
          />
          <TextField
            id="cf-last-name"
            label={tf('lastName')}
            required
            autoComplete="family-name"
            maxLength={100}
            error={errors.last_name?.message}
            {...register('last_name')}
          />
        </div>

        <TextField
          id="cf-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          label={tf('email')}
          required={emailEditable}
          maxLength={254}
          // Read-only (not `disabled`) for a linked primary so the field stays
          // focusable — a disabled input is skipped by screen readers in forms
          // mode, which would hide its note. The PATCH already guards on
          // `emailEditable`, so no value leaks.
          readOnly={!emailEditable}
          hint={!emailEditable ? t('emailEditNote') : undefined}
          error={emailEditable ? errors.email?.message : undefined}
          {...register('email')}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            id="cf-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            label={tf('phone')}
            maxLength={20}
            placeholder="+66812345678"
            error={errors.phone?.message}
            {...register('phone')}
          />
          <TextField
            id="cf-role"
            label={tf('roleTitle')}
            autoComplete="organization-title"
            maxLength={100}
            {...register('role_title')}
          />
        </div>

        <Select
          id="cf-language"
          label={tf('preferredLanguage')}
          options={languageOptions}
          {...register('preferred_language')}
        />

        {mode === 'add' && (
          // Task 8 (GDPR Art. 14) — this contact's data is supplied by the
          // admin, not the person themselves (a third party). The admin
          // must attest they informed that person the chamber holds their
          // details, and where to find the privacy notice, before this
          // contact can be added.
          <Controller
            control={control}
            name="art14_attested"
            render={({ field }) => (
              <Checkbox
                id="cf-art14-attested"
                checked={field.value ?? false}
                onChange={(checked) => field.onChange(checked)}
                aria-invalid={Boolean(errors.art14_attested) || undefined}
                description={
                  errors.art14_attested ? (
                    <span id="cf-art14-attested-error" role="alert" className="text-[var(--aura-fg-danger)]">
                      {errors.art14_attested.message}
                    </span>
                  ) : undefined
                }
              >
                {t('art14AttestationLabel')}
              </Checkbox>
            )}
          />
        )}
      </form>
    </Dialog>
  );
}
