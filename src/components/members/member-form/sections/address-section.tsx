'use client';

/**
 * MemberForm — Address section (optional, structured).
 *
 * Extracted from the former single-file `member-form.tsx` (pure move, PR-B
 * task 4) — reads/writes form state via `useFormContext` instead of
 * prop-drilled `register`/`errors`.
 */
import { useTranslations } from 'next-intl';
import { useFormContext } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldError } from '../field-error';
import { type MemberFormValues } from '../schema';

export function AddressSection() {
  const t = useTranslations('admin.members.create');
  const tf = useTranslations('admin.members.create.fields');
  const {
    register,
    formState: { errors },
  } = useFormContext<MemberFormValues>();

  return (
    <fieldset className="flex flex-col gap-4 rounded-md border p-4">
      <legend className="px-2 text-base font-semibold">
        {t('sections.address')}
      </legend>
      <div>
        <Label htmlFor="address_line1">{tf('addressLine1')}</Label>
        <Input
          id="address_line1"
          {...register('address_line1')}
          maxLength={200}
          autoComplete="address-line1"
          aria-invalid={Boolean(errors.address_line1)}
          aria-describedby={
            errors.address_line1 ? 'address_line1-error' : undefined
          }
        />
        <FieldError
          id="address_line1-error"
          message={errors.address_line1?.message}
        />
      </div>
      <div>
        <Label htmlFor="address_line2">{tf('addressLine2')}</Label>
        <Input
          id="address_line2"
          {...register('address_line2')}
          maxLength={200}
          autoComplete="address-line2"
          aria-invalid={Boolean(errors.address_line2)}
          aria-describedby={
            errors.address_line2 ? 'address_line2-error' : undefined
          }
        />
        <FieldError
          id="address_line2-error"
          message={errors.address_line2?.message}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <Label htmlFor="city">{tf('city')}</Label>
          <Input
            id="city"
            {...register('city')}
            maxLength={100}
            autoComplete="address-level2"
            aria-invalid={Boolean(errors.city)}
            aria-describedby={errors.city ? 'city-error' : undefined}
          />
          <FieldError id="city-error" message={errors.city?.message} />
        </div>
        <div>
          <Label htmlFor="province">{tf('province')}</Label>
          <Input
            id="province"
            {...register('province')}
            maxLength={100}
            autoComplete="address-level1"
            aria-invalid={Boolean(errors.province)}
            aria-describedby={errors.province ? 'province-error' : undefined}
          />
          <FieldError id="province-error" message={errors.province?.message} />
        </div>
        <div>
          <Label htmlFor="postal_code">{tf('postalCode')}</Label>
          <Input
            id="postal_code"
            {...register('postal_code')}
            maxLength={20}
            autoComplete="postal-code"
            aria-invalid={Boolean(errors.postal_code)}
            aria-describedby={
              errors.postal_code ? 'postal_code-error' : undefined
            }
          />
          <FieldError
            id="postal_code-error"
            message={errors.postal_code?.message}
          />
        </div>
      </div>
    </fieldset>
  );
}
