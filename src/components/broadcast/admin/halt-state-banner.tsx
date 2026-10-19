/**
 * T121 — Halt-state banner. Q14 / R3-NEW-3.
 *
 * Top-of-page red banner shown whenever ≥1 member in tenant has
 * `broadcasts_halted_until_admin_review = true`. Lists each halted
 * member with a "Review + Clear halt" button that opens a typed-phrase
 * confirmation dialog (F4 destructive-action convention).
 *
 * Server component that hydrates the client clear-halt dialog per row.
 * `manager` role sees the banner but no clear-action button (read-only
 * per FR-014; conditional rendering at the call site).
 */
import Link from 'next/link';
import { Alert } from '@jirawatpyk/aura-react/server';
import { getLocale, getTranslations } from 'next-intl/server';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { env } from '@/lib/env';
import { ClearHaltDialog, HALT_BANNER_HEADING_ID } from './clear-halt-dialog';

export interface HaltedMember {
  readonly memberId: string;
  readonly displayName: string;
  readonly haltedSinceAt: Date;
}

export interface HaltStateBannerProps {
  readonly halted: ReadonlyArray<HaltedMember>;
  /** Hide clear-halt action for manager role. */
  readonly readOnly?: boolean;
}

export async function HaltStateBanner({
  halted,
  readOnly = false,
}: HaltStateBannerProps): Promise<React.ReactElement | null> {
  if (halted.length === 0) return null;
  const t = await getTranslations('admin.broadcasts.haltBanner');
  const locale = await getLocale();
  const fmt = new Intl.DateTimeFormat(
    getDateFormatLocale(locale),
    // Tenant-TZ pin (#315 follow-up, server-UTC display class): the halt
    // timestamp is an instant — its UTC calendar day differs from the
    // Bangkok day for instants ≥ 17:00 UTC.
    { dateStyle: 'medium', timeZone: env.tenant.timezone },
  );

  // Spec 122 US12b — an AURA danger Alert inside the named region, keeping
  // the h2 the clear-halt dialog returns focus to.
  return (
    <section aria-label={t('title', { count: halted.length })}>
      <Alert tone="danger" role="none" icon="shield-alert">
        <div className="flex flex-col gap-[var(--aura-space-3)]">
          <div>
            {/* h2: PageHeader is the page h1; halt banner shares h2 with SLA banner.
                T155 U3 — `tabIndex={-1}` makes it focusable (not tabbable, so
                it adds no tab stop): it is where `ClearHaltDialog` lands focus
                after the cleared row's trigger unmounts. */}
            <h2
              id={HALT_BANNER_HEADING_ID}
              tabIndex={-1}
              className="aura-text-body font-semibold focus-visible:outline-none"
            >
              {t('title', { count: halted.length })}
            </h2>
            <p>{t('body')}</p>
          </div>
          <ul className="flex flex-col gap-[var(--aura-space-2)]">
            {halted.map((m) => (
              <li
                key={m.memberId}
                className="flex flex-wrap items-center justify-between gap-[var(--aura-space-2)] max-sm:flex-col max-sm:items-stretch rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface)] px-[var(--aura-space-3)] py-[var(--aura-space-2)]"
              >
                <div>
                  {/* Smart-G3 (round-3) — deep-link to F3 member detail so admin
                      can investigate plan tier + activity before clearing halt. */}
                  <Link
                    href={`/admin/members/${m.memberId}`}
                    className="inline-flex min-h-11 items-center aura-text-body font-medium text-[var(--aura-fg-accent)] hover:underline focus-visible:underline sm:min-h-0"
                  >
                    {m.displayName}
                  </Link>
                  <p className="aura-text-caption text-[var(--aura-fg-secondary)]">
                    {t('haltedSince', { date: fmt.format(m.haltedSinceAt) })}
                  </p>
                </div>
                {!readOnly ? (
                  <ClearHaltDialog memberId={m.memberId} memberDisplayName={m.displayName} />
                ) : (
                  // UX I8: an inline note says WHY a manager cannot act (a
                  // disabled button would not). T155 U5 — NO italic: Thai has
                  // no italic form; weight carries the aside instead.
                  <span className="aura-text-caption font-medium text-[var(--aura-fg-secondary)]">
                    {t('readOnlyNote')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </Alert>
    </section>
  );
}
