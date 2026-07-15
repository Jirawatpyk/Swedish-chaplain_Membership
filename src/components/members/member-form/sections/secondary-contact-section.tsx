'use client';

/**
 * MemberForm — Secondary contact section (CREATE only, PR-B task 8).
 *
 * Additive disclosure, NOT a negative opt-out checkbox: the reviewer asked
 * for a "No secondary contact" checkbox, unchecked by default. An
 * unchecked-by-default box makes a second natural person's name/email/phone
 * REQUIRED BY DEFAULT — friction on the majority path, and it inverts GDPR
 * Art. 25(2) (data protection BY DEFAULT). It is also a negative checkbox,
 * which users reliably mis-parse. Instead: a `+ Add a secondary contact`
 * button (mirrors the Add-contact trigger on the member detail page) reveals
 * `<ContactFields prefix="secondary_contact">`; a Remove action UNREGISTERS
 * the whole sub-object — clearing the underlying form VALUE, not just
 * hiding the widget — so a filled-then-removed secondary contact never
 * rides along on submit.
 *
 * Edit-page parity note: the Edit page already has full contact CRUD
 * (add / edit / promote-to-primary via ContactFormDialog + ContactActions)
 * — this section is CREATE-ONLY (member-form.tsx gates it on
 * `mode === 'create'`) so the two surfaces never become two sources of
 * truth for the same rows.
 */
import { useEffect, useRef, useState } from 'react';
import { Controller, useFormContext } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { UserPlusIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { FieldError } from '../field-error';
import { ContactFields } from './contact-fields';
import { type MemberFormValues } from '../schema';

export function SecondaryContactSection() {
  const t = useTranslations('admin.members.create');
  const tf = useTranslations('admin.members.create.fields');
  const {
    unregister,
    setValue,
    control,
    formState: { errors },
  } = useFormContext<MemberFormValues>();
  const [expanded, setExpanded] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  // Task 8 review-fix (Minor 4) — Remove unmounts the whole fieldset with no
  // focus target, dropping a keyboard user to <body> (top of document). This
  // flag distinguishes "collapsed because Remove just ran" from the initial
  // (already-collapsed) mount, so the effect below never steals focus on
  // first paint — only after an explicit Remove.
  const shouldFocusAddButtonRef = useRef(false);

  useEffect(() => {
    if (!expanded && shouldFocusAddButtonRef.current) {
      shouldFocusAddButtonRef.current = false;
      addButtonRef.current?.focus();
    }
  }, [expanded]);

  const handleAdd = () => {
    // Seed `preferred_language` explicitly — unlike the primary contact
    // (whose defaultValues always carry `preferred_language: 'en'` from
    // mount, see member-form.tsx), a freshly-expanded secondary contact has
    // NO defaultValues at all. `ContactFields`' Select only DISPLAYS an
    // 'en' fallback (`field.value ?? 'en'`) — the underlying RHF value stays
    // `undefined` until the admin actually opens the dropdown, and
    // `z.enum(['en','th','sv'])` rejects `undefined`. Without this, an
    // admin who fills in first/last/email and accepts the visually-shown
    // "English" default would hit an invisible submit failure (the Select
    // trigger has no `aria-invalid` wiring to surface it).
    setValue('secondary_contact.preferred_language', 'en');
    setExpanded(true);
  };

  const handleRemove = () => {
    // Unregister the WHOLE sub-object (not each leaf field individually) —
    // react-hook-form clears its value + validation state for every
    // registered descendant path in one call. Without this, a
    // filled-then-removed secondary contact would still ride along in the
    // submitted values (the widget unmounts, but the RHF value survives).
    unregister('secondary_contact');
    shouldFocusAddButtonRef.current = true;
    setExpanded(false);
  };

  if (!expanded) {
    return (
      <Button
        ref={addButtonRef}
        type="button"
        variant="outline"
        onClick={handleAdd}
        className="w-fit gap-2"
      >
        <UserPlusIcon className="size-4" aria-hidden="true" />
        {t('secondaryContact.addButton')}
      </Button>
    );
  }

  return (
    <fieldset className="flex flex-col gap-4 rounded-md border p-4">
      <legend className="px-2 text-base font-semibold">
        {t('sections.secondaryContact')}
      </legend>
      <ContactFields
        prefix="secondary_contact"
        idPrefix="secondary_contact"
        showDateOfBirth={false}
        required
      />
      {/* Task 8 (GDPR Art. 14) — the admin must attest they informed this
          third party (whose data they, not the person, are supplying) that
          the chamber holds their details, and where to find the privacy
          notice. Blocks submit until checked (schema.ts refine). */}
      <div className="flex items-start gap-2">
        <Controller
          control={control}
          name="secondary_contact.art14_attested"
          defaultValue={false}
          render={({ field }) => (
            <Checkbox
              id="secondary_contact_art14_attested"
              className="mt-0.5"
              // Base UI Checkbox.Root's visible role=checkbox element uses its
              // own generated id, so a sibling <Label htmlFor> can't reliably
              // name it — set the accessible name directly (same fix as
              // tax-branch-section.tsx's is_head_office checkbox).
              aria-label={tf('art14AttestationLabel')}
              aria-invalid={Boolean(errors.secondary_contact?.art14_attested)}
              aria-describedby={
                errors.secondary_contact?.art14_attested
                  ? 'secondary_contact_art14_attested-error'
                  : undefined
              }
              checked={field.value ?? false}
              onCheckedChange={(checked) => field.onChange(checked === true)}
            />
          )}
        />
        <div>
          <Label
            htmlFor="secondary_contact_art14_attested"
            className="font-normal"
          >
            {tf('art14AttestationLabel')}
          </Label>
          <FieldError
            id="secondary_contact_art14_attested-error"
            message={errors.secondary_contact?.art14_attested?.message}
          />
        </div>
      </div>
      <Button
        type="button"
        variant="destructive-outline"
        size="sm"
        onClick={handleRemove}
        className="w-fit gap-2"
      >
        <Trash2Icon className="size-4" aria-hidden="true" />
        {t('secondaryContact.removeButton')}
      </Button>
    </fieldset>
  );
}
