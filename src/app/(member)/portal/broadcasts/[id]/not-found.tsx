/**
 * F7 US3 AS5 — broadcast detail not-found UI.
 *
 * Rendered when the page calls `notFound()` because the requested
 * broadcast does not exist OR is owned by a different member
 * (anti-enumeration: absent-row and cross-member probe are
 * indistinguishable to the caller).
 *
 * Without a segment-level `not-found.tsx`, Next.js 16 RSC streaming
 * can commit response headers (with status 200) before `notFound()`
 * resolves — the rendered body is still the not-found UI but the
 * HTTP status leaks 200 in dev mode. A dedicated segment-level
 * not-found.tsx (combined with `export const dynamic = 'force-dynamic'`
 * on the page) restores the spec-mandated 404 status in production.
 * See `tests/e2e/member-quota-history.spec.ts` AS5 for the dev-vs-prod
 * status nuance.
 *
 * F119 T086a V6 — the heading and the paragraph were the same string
 * (`errors.notFound` twice). Each now has its own key; the body names no
 * reason, so "absent" and "someone else's" still read alike.
 */
import Link from 'next/link';
import { ArrowLeft, FileQuestion } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Icon, buttonClass } from '@jirawatpyk/aura-react/server';

export default async function BroadcastNotFound(): Promise<React.ReactElement> {
  const t = await getTranslations('portal.broadcasts.detail');

  return (
    // F2 UX hardening — full empty-state anatomy per ux-standards § 3.1:
    // muted icon (48px), heading, explanatory paragraph, primary CTA.
    // Previously: just a flat `<p>` — visually anaemic and SR users had
    // no heading landmark for the state.
    <DetailContainer>
      <PageHeader title={t('title')} />
      <div
        data-testid="broadcast-not-found"
        className="flex flex-col items-center gap-3 rounded-[var(--aura-card-radius)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] p-12 text-center"
      >
        <Icon name={<FileQuestion />} size={48} className="text-[var(--aura-fg-secondary)]" />
        <h2 className="m-0 aura-text-h3">{t('notFound.title')}</h2>
        <p className="m-0 max-w-md aura-text-body text-[var(--aura-fg-secondary)]">{t('notFound.body')}</p>
        <Link
          href="/portal/benefits?tab=broadcasts"
          className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true, className: 'mt-2' })}
        >
          <Icon name={<ArrowLeft />} size={16} />
          {t('back')}
        </Link>
      </div>
    </DetailContainer>
  );
}
