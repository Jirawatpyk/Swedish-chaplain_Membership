'use client';

/**
 * The dead-link state of the reset and invite pages (spec 122 US2,
 * `Auth-expired` boards): an AURA danger alert with the way forward as its
 * action. The boards draw that as an inline link; it is a secondary link
 * button here so the target is 44px (ux-standards § 9.1). A client component
 * because server pages never import AURA.
 *
 * `autoFocus` moves focus to the alert when it replaces a form mid-flow (the
 * API answered 410), so a keyboard or screen-reader user lands on the reason
 * instead of on a vanished submit button.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Alert, Button } from '@jirawatpyk/aura-react';
import { AURA_FOCUS_RING } from '@/components/shell/aura-classes';
import { cn } from '@/lib/utils';

export interface AuthLinkInvalidProps {
  readonly message: ReactNode;
  /** A second line: what to do when there is no self-service path (invitations). */
  readonly detail?: ReactNode | undefined;
  readonly action?: { readonly label: string; readonly href: string } | undefined;
  readonly autoFocus?: boolean | undefined;
}

export function AuthLinkInvalid({ message, detail, action, autoFocus = false }: AuthLinkInvalidProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  return (
    <div ref={ref} tabIndex={-1} className={cn('rounded-[var(--aura-radius-lg)]', AURA_FOCUS_RING)}>
      <Alert
        tone="danger"
        action={
          action ? (
            <Button href={action.href} linkComponent="a" variant="secondary">
              {action.label}
            </Button>
          ) : undefined
        }
      >
        {message}
        {detail ? <p className="mt-1">{detail}</p> : null}
      </Alert>
    </div>
  );
}
