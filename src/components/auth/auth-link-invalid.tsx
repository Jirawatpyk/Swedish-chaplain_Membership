'use client';

/**
 * The dead-link state of the reset and invite pages (spec 122 US2,
 * `Auth-expired` boards): an AURA danger alert with a bold title and one line
 * of guidance, then the way forward as full-width buttons under it — the
 * primary action where there is a self-service path (a new reset link), and
 * "Back to sign in". A client component because server pages never import
 * AURA's root.
 *
 * `autoFocus` moves focus to the block when it replaces a form mid-flow (the
 * API answered 410), so a keyboard or screen-reader user lands on the reason
 * instead of on a vanished submit button.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Alert, Button } from '@jirawatpyk/aura-react';
import { AURA_FOCUS_RING } from '@/components/shell/aura-classes';
import { cn } from '@/lib/utils';

interface LinkAction {
  readonly label: string;
  readonly href: string;
}

export interface AuthLinkInvalidProps {
  /** What happened — the alert's bold title. */
  readonly title: ReactNode;
  /** What to do about it — the alert's body. */
  readonly detail?: ReactNode | undefined;
  /** The self-service way forward, when there is one (a new reset link). */
  readonly action?: LinkAction | undefined;
  /** Back to the sign-in page. */
  readonly back: LinkAction;
  readonly autoFocus?: boolean | undefined;
}

export function AuthLinkInvalid({ title, detail, action, back, autoFocus = false }: AuthLinkInvalidProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  return (
    <div ref={ref} tabIndex={-1} className={cn('flex flex-col gap-5 rounded-[var(--aura-radius-lg)]', AURA_FOCUS_RING)}>
      <Alert tone="danger" title={title}>
        {detail}
      </Alert>
      <div className="flex flex-col gap-2">
        {action ? (
          <Button href={action.href} linkComponent="a" variant="primary" fullWidth>
            {action.label}
          </Button>
        ) : null}
        <Button href={back.href} linkComponent="a" variant="secondary" icon="arrow-left" fullWidth>
          {back.label}
        </Button>
      </div>
    </div>
  );
}
