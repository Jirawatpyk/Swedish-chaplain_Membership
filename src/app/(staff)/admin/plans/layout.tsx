/**
 * T085 — Plans section layout (US1).
 *
 * Thin wrapper around the children with a breadcrumb + title row.
 * The staff shell (header, sign-out, theme toggle) is inherited from
 * `src/app/(staff)/admin/layout.tsx`. This layer exists so every plans
 * route shares a consistent heading band without repeating markup.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ChevronRightIcon } from 'lucide-react';

export default async function PlansLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('admin.plans');

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <ol className="flex items-center gap-1">
          <li>
            <Link href="/admin" className="hover:text-foreground">
              Dashboard
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRightIcon className="inline h-4 w-4" />
          </li>
          <li className="font-medium text-foreground">{t('title')}</li>
        </ol>
      </nav>
      {children}
    </div>
  );
}
