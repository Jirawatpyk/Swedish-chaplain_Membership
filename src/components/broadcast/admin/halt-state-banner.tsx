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
import { ShieldAlert } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { ClearHaltDialog } from './clear-halt-dialog';

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
    locale === 'th' ? 'th-TH-u-ca-buddhist' : locale,
    { dateStyle: 'medium' },
  );

  return (
    <div
      role="region"
      aria-label={t('title', { count: halted.length })}
      className="rounded-md border border-destructive/40 bg-destructive/10 p-4 dark:bg-destructive/20"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert
          className="mt-0.5 h-5 w-5 shrink-0 text-destructive"
          aria-hidden="true"
        />
        <div className="flex-1 space-y-3">
          <div>
            {/* h2: PageHeader is the page h1; halt banner shares h2 with SLA banner */}
            <h2 className="text-sm font-semibold text-destructive">
              {t('title', { count: halted.length })}
            </h2>
            <p className="text-sm text-muted-foreground">{t('body')}</p>
          </div>
          <ul className="space-y-1.5">
            {halted.map((m) => (
              <li
                key={m.memberId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background/60 px-3 py-2 dark:bg-background/30"
              >
                <div>
                  {/* Smart-G3 (round-3) — deep-link to F3 member detail
                      so admin can investigate plan tier + activity
                      history before clearing halt. */}
                  <Link
                    href={`/admin/members/${m.memberId}`}
                    className="text-sm font-medium hover:underline focus-visible:underline"
                  >
                    {m.displayName}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {t('haltedSince', { date: fmt.format(m.haltedSinceAt) })}
                  </p>
                </div>
                {!readOnly ? (
                  <ClearHaltDialog
                    memberId={m.memberId}
                    memberDisplayName={m.displayName}
                  />
                ) : (
                  // UX I8: a disabled button fails contrast + tells the
                  // manager nothing about WHY they can't act. Render an
                  // inline note instead so the role limitation is
                  // self-explanatory.
                  <span className="text-xs italic text-muted-foreground">
                    {t('readOnlyNote')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
