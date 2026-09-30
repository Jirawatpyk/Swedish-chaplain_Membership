/**
 * 122 US5b-2 (T572) — the frame of the new and edit member pages (boards
 * `Admin-member-new`, `-edit`): the title and Cancel at the
 * top right as the boards draw it. Below 1024px the shell's "← back" link
 * stands in for it and the form's pinned action bar carries Cancel.
 *
 * Each page wraps it in its own `FormContainer` (check:layout reads the page
 * file) with `MEMBER_FORM_COLUMN`: the boards set the 672px column at the
 * page's start edge, not centred.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeftIcon } from 'lucide-react';
import { buttonClass } from '@jirawatpyk/aura-react/server';
import { PageHeader } from '@/components/layout/page-header';

export const MEMBER_FORM_COLUMN = 'mx-0';

export function MemberFormFrame({
  title,
  subtitle,
  cancelHref,
  cancelLabel,
  children,
}: {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly cancelHref?: string;
  readonly cancelLabel?: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          cancelHref && cancelLabel ? (
            <Link href={cancelHref} className={buttonClass({ variant: 'secondary', className: 'max-lg:hidden' })}>
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
              {cancelLabel}
            </Link>
          ) : null
        }
      />
      {children}
    </>
  );
}
