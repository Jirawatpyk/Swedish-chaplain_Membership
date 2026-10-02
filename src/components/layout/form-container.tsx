import type { ReactNode } from 'react';
import { Container } from '@jirawatpyk/aura-react/server';

import { cn } from '@/lib/utils';

type FormContainerProps = {
  children: ReactNode;
  className?: string;
  /**
   * `start` puts the column at the page's start edge instead of centring it:
   * the staff member and plan forms, as their boards draw them (AURA 5.26,
   * #126). Default `center`.
   */
  align?: 'center' | 'start';
  /** Pass-through ARIA busy signal for loading.tsx skeleton renders, as on the detail and table containers. */
  'aria-busy'?: boolean | 'true' | 'false';
};

/**
 * The form page column: AURA's narrow `Container` (720px, the maintainer's
 * width decision of 2 Oct 2026), with the app's own page gutter, which steps
 * at 768 and 1024px (AURA's steps at 640 and 1024px; a utility wins under
 * `styles.layer.css`, AURA 5.27 #131). `data-slot` / `data-variant` are what
 * `check:layout`, the e2e width specs and the portal hero rule select on.
 */
export function FormContainer({ children, className, align = 'center', 'aria-busy': ariaBusy }: FormContainerProps) {
  return (
    <Container
      size="narrow"
      align={align}
      data-slot="layout-container"
      data-variant="form"
      aria-busy={ariaBusy}
      className={cn(
        'px-[var(--page-padding-x)] pt-[var(--page-padding-y)] pb-[var(--page-padding-bottom)]',
        'flex flex-col gap-[var(--page-section-gap)]',
        className,
      )}
    >
      {children}
    </Container>
  );
}
