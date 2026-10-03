'use client';

/**
 * 088 T065b (FR-031, ภ.พ.30 support) — register picker for the tax-document
 * registers page. Chooses the register kind (§86/4 RC register / §80/1(5)
 * zero-rate sales / §105 RE register) + an inclusive Bangkok-local period, then
 * navigates to the server-rendered register via URL params (`?kind`/`?from`/
 * `?to`) — the page is the source of truth, so the register is bookmarkable +
 * shareable.
 *
 * Spec 122 US8c (T846) — on AURA fields (board `Admin-invoice-registers`):
 * the register Select, From and To date fields and View register in one row,
 * stacked on a phone. The push is unchanged.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Select, TextField } from '@jirawatpyk/aura-react';

type RegisterKind = 'rc_register' | 'zero_rate_sales' | 're_register';

interface TaxRegisterFormProps {
  readonly initialKind: RegisterKind;
  readonly initialFrom: string;
  readonly initialTo: string;
}

export function TaxRegisterForm({
  initialKind,
  initialFrom,
  initialTo,
}: TaxRegisterFormProps): React.JSX.Element {
  const t = useTranslations('admin.invoices.registers');
  const router = useRouter();
  const [kind, setKind] = React.useState<RegisterKind>(initialKind);
  const [from, setFrom] = React.useState(initialFrom);
  const [to, setTo] = React.useState(initialTo);

  const onSubmit = React.useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const params = new URLSearchParams({ kind, from, to });
      // Same-page register/period selection (the register table re-renders
      // below this form) → preserve scroll (canonical rule comment:
      // renewals `urgency-bucket-tabs.tsx` handleChange).
      router.push(`/admin/invoices/registers?${params.toString()}`, {
        scroll: false,
      });
    },
    [router, kind, from, to],
  );

  return (
    <form
      onSubmit={onSubmit}
      className="grid grid-cols-1 gap-[var(--aura-space-3)] sm:grid-cols-2 lg:grid-cols-[minmax(0,18rem)_minmax(0,12rem)_minmax(0,12rem)_auto] lg:items-end"
    >
      <Select
        id="register-kind"
        label={t('kind.label')}
        value={kind}
        onChange={(e) => setKind(e.currentTarget.value as RegisterKind)}
        options={[
          { value: 'rc_register', label: t('kind.rcRegister') },
          { value: 'zero_rate_sales', label: t('kind.zeroRateSales') },
          { value: 're_register', label: t('kind.reRegister') },
        ]}
        className="sm:col-span-2 lg:col-span-1"
      />
      <TextField
        id="register-from"
        type="date"
        label={t('fields.from')}
        value={from}
        onChange={(e) => setFrom(e.currentTarget.value)}
        required
      />
      <TextField
        id="register-to"
        type="date"
        label={t('fields.to')}
        value={to}
        onChange={(e) => setTo(e.currentTarget.value)}
        required
      />
      <Button type="submit" variant="primary" touchHeight className="sm:col-span-2 lg:col-span-1">
        {t('actions.view')}
      </Button>
    </form>
  );
}
