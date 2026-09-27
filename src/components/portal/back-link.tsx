import Link from 'next/link';
import { ArrowLeftIcon } from 'lucide-react';

/**
 * The portal boards' "← Back to …" text link above a page title
 * (`Portal-change-requests`, `Portal-contacts-invite`): 13px accent text,
 * a 44px target on phones.
 */
export function BackLink({ href, children }: { readonly href: string; readonly children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="-mb-1 inline-flex min-h-11 items-center gap-1.5 self-start text-[13px] font-medium text-[var(--aura-fg-accent)] no-underline hover:underline sm:min-h-0"
    >
      <ArrowLeftIcon className="aura-icon size-4" aria-hidden />
      {children}
    </Link>
  );
}
