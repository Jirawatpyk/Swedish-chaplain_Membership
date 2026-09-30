'use client';

/**
 * MemberForm — Secondary contact section (CREATE only, PR-B task 8).
 *
 * Additive disclosure, NOT a negative opt-out checkbox: the reviewer asked
 * for a "No secondary contact" checkbox, unchecked by default. An
 * unchecked-by-default box makes a second natural person's name/email/phone
 * REQUIRED BY DEFAULT — friction on the majority path, and it inverts GDPR
 * Art. 25(2) (data protection BY DEFAULT). It is also a negative checkbox,
 * which users reliably mis-parse. Instead: a "Add a secondary contact"
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
import { Trash2Icon } from 'lucide-react';
import { Button, Checkbox } from '@jirawatpyk/aura-react';
import { ContactFields } from './contact-fields';
import { type MemberFormValues } from '../schema';
import { FormSectionCard } from '../form-section-card';

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
        variant="secondary"
        icon="plus"
        onClick={handleAdd}
        className="w-fit"
      >
        {t('secondaryContact.addButton')}
      </Button>
    );
  }

  const art14Error = errors.secondary_contact?.art14_attested?.message;

  return (
    <FormSectionCard id="secondary-contact" title={t('sections.secondaryContact')}>
      <div className="flex flex-col gap-4">
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
        <div className="flex flex-col gap-1">
          <Controller
            control={control}
            name="secondary_contact.art14_attested"
            defaultValue={false}
            render={({ field }) => (
              <Checkbox
                id="secondary_contact_art14_attested"
                name={field.name}
                ref={field.ref}
                onBlur={field.onBlur}
                aria-invalid={Boolean(art14Error)}
                aria-describedby={art14Error ? 'secondary_contact_art14_attested-error' : undefined}
                checked={field.value ?? false}
                onChange={(checked) => field.onChange(checked)}
              >
                {tf('art14AttestationLabel')}
              </Checkbox>
            )}
          />
          {art14Error && (
            <p id="secondary_contact_art14_attested-error" className="ms-6 text-xs text-[var(--aura-fg-danger)]">
              {art14Error}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="danger-secondary"
          size="sm"
          icon={<Trash2Icon className="size-4" aria-hidden="true" />}
          onClick={handleRemove}
          className="w-fit"
        >
          {t('secondaryContact.removeButton')}
        </Button>
      </div>
    </FormSectionCard>
  );
}
