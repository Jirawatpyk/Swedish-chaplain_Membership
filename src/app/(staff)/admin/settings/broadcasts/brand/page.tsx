/**
 * F119 T028 — `/admin/settings/broadcasts/brand`, the chamber brand page
 * (FR-041b/c; contracts/admin-eblast-formatting-api.md § "the Brand page").
 *
 * Lives under the staff Settings area beside the existing E-Blast settings
 * page, not under `/admin/broadcasts` — the logo, the colour and the postal
 * address are tenant configuration, not a broadcast.
 *
 * Two gates, in this order:
 *
 *   1. `requirePagePermission('settings.broadcasts')` — the same key the
 *      sidebar entry, the Settings-index card and both verbs of
 *      `/api/admin/broadcasts/brand` name. `marketing` does not hold it, so
 *      the surface is INVISIBLE to it, not disabled: no nav entry, no hub
 *      card, no page.
 *   2. `env.features.f7Broadcasts` → `notFound()`. The proxy kill-switch
 *      predicate (`matchesF7KillSwitchPath`, `src/proxy.ts`) covers
 *      `/admin/broadcasts` and NOT `/admin/settings/**` (research R18), so a
 *      switched-off F7 would otherwise leave this URL serving while its nav
 *      entry and hub card were hidden — a one-sided gate.
 *
 * `logo.manageHref` is decided by the evaluator on the SESSION role:
 * `settings.invoicing` is super-admin-only, so a plain admin sees "ask an
 * administrator" rather than a link into a page their own guard denies.
 * A read failure reaches `error.tsx` rather than rendering a form that
 * asserts "no colour, no address" about a row we could not read.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { BrandSettingsForm } from '@/components/broadcast/brand/brand-settings-form';
import { makeBrandSettingsDeps } from '@/lib/broadcast-brand-deps';
import { env } from '@/lib/env';
import { canPerform, requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { getBrandSettings } from '@/modules/broadcasts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.settings.broadcasts.brand');
  return { title: t('pageTitle') };
}

export default async function BrandSettingsPage(): Promise<React.ReactElement> {
  const { user } = await requirePagePermission('settings.broadcasts');
  if (!env.features.f7Broadcasts) notFound();

  const tenantCtx = resolveTenantFromRequest();
  const t = await getTranslations('admin.settings.broadcasts.brand');

  const view = await getBrandSettings(makeBrandSettingsDeps(), {
    tenantId: tenantCtx.slug as never,
    // rbac-subgate-ok: gates the `logo.manageHref` FIELD of a page the caller
    // is already admitted to — admission is `settings.broadcasts` above. Same
    // decision the route makes for the same field.
    canManageInvoiceSettings: canPerform(user.role, 'settings.invoicing'),
  });

  return (
    <FormContainer>
      <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} />
      <BrandSettingsForm initial={view} />
    </FormContainer>
  );
}
