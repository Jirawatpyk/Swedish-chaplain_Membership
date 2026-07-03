'use client';

/**
 * 088 T065b (FR-031, ภ.พ.30 support) — register picker for the tax-document
 * registers page. Chooses the register kind (§86/4 RC register / §80/1(5)
 * zero-rate sales / §105 RE register) + an inclusive Bangkok-local period, then
 * navigates to the server-rendered register via URL params (`?kind`/`?from`/
 * `?to`) — the page is the source of truth, so the register is bookmarkable +
 * shareable.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';

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
      router.push(`/admin/invoices/registers?${params.toString()}`);
    },
    [router, kind, from, to],
  );

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
      <div className="min-w-0 space-y-2 sm:w-[18rem]">
        <Label htmlFor="register-kind">{t('kind.label')}</Label>
        <Select value={kind} onValueChange={(v) => setKind(v as RegisterKind)}>
          <SelectTrigger id="register-kind" className="w-full">
            {/* TranslatedSelectValue: Base UI renders the raw enum
                ('rc_register'…) in the collapsed trigger with a bare
                <SelectValue/>. Map each kind to its localized label so the
                trigger is readable in every locale (B2 review FINDING 2). */}
            <TranslatedSelectValue
              translate={(v) =>
                v === 'zero_rate_sales'
                  ? t('kind.zeroRateSales')
                  : v === 're_register'
                    ? t('kind.reRegister')
                    : t('kind.rcRegister')
              }
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="rc_register">{t('kind.rcRegister')}</SelectItem>
            <SelectItem value="zero_rate_sales">{t('kind.zeroRateSales')}</SelectItem>
            <SelectItem value="re_register">{t('kind.reRegister')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="register-from">{t('fields.from')}</Label>
        <Input
          id="register-from"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.currentTarget.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="register-to">{t('fields.to')}</Label>
        <Input
          id="register-to"
          type="date"
          value={to}
          onChange={(e) => setTo(e.currentTarget.value)}
          required
        />
      </div>
      <Button type="submit">{t('actions.view')}</Button>
    </form>
  );
}
