'use client';

/**
 * Layout B (maintainer, 22 Oct; board `Admin-member-detail`) — "All company
 * details" opens the member's full company record in a side Drawer, so the
 * page keeps a short summary card in its aside. The record itself is
 * server-rendered and arrives as `children`; this island only owns the
 * open state. Focus returns to the trigger when it closes, also where a
 * click does not focus the button (Safari): AURA's Drawer would otherwise
 * restore the `body` it saw at open. It opens on the record's first visible
 * control; on a member with no Tax ID or website that is the closed Technical
 * disclosure's summary, never a copy button hidden inside it (AURA 5.57, #169).
 */
import { useRef, useState, type ReactNode } from 'react';
import { Button, Drawer } from '@jirawatpyk/aura-react';

export function CompanyDetailsDrawer({
  triggerLabel,
  title,
  description,
  closeLabel,
  children,
}: {
  readonly triggerLabel: string;
  readonly title: string;
  /** The company's name under the title, so the dialog says whose record it is. */
  readonly description?: string;
  readonly closeLabel: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={triggerRef}
        variant="secondary"
        size="sm"
        touchHeight
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        data-testid="company-details-open"
      >
        {triggerLabel}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        finalFocus={triggerRef}
        side="right"
        size="md"
        title={title}
        description={description}
        closeLabel={closeLabel}
        closeProps={{ touchHeight: true }}
        data-testid="company-details-drawer"
      >
        {children}
      </Drawer>
    </>
  );
}
