import Link from 'next/link';
import { ArrowLeftIcon } from 'lucide-react';
import { Icon } from '@jirawatpyk/aura-react/server';

/**
 * The portal boards' "← Back to …" text link above a page title
 * (`Portal-change-requests`, `Portal-contacts-invite`): AURA's 13px label in accent,
 * a 44px target on phones.
 */
export function BackLink({ href, children }: { readonly href: string; readonly children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="-mb-1 inline-flex min-h-11 items-center gap-1.5 self-start aura-text-label text-[var(--aura-fg-accent)] no-underline hover:underline sm:min-h-0"
    >
      <Icon name={<ArrowLeftIcon />} size={16} />
      {children}
    </Link>
  );
}
