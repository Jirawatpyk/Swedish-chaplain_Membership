'use client';

/**
 * Layout B (maintainer, 22 Oct; board `Admin-member-detail`) — "All company
 * details" opens the member's full company record in a side Drawer, so the
 * page keeps a short summary card in its aside. The record itself is
 * server-rendered and arrives as `children`; this island only owns the
 * open state. AURA returns focus to the trigger when it closes.
 */
import { useState, type ReactNode } from 'react';
import { Button, Drawer } from '@jirawatpyk/aura-react';

export function CompanyDetailsDrawer({
  triggerLabel,
  title,
  closeLabel,
  children,
}: {
  readonly triggerLabel: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" touchHeight onClick={() => setOpen(true)} data-testid="company-details-open">
        {triggerLabel}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        side="right"
        size="md"
        title={title}
        closeLabel={closeLabel}
        closeProps={{ touchHeight: true }}
        data-testid="company-details-drawer"
      >
        {children}
      </Drawer>
    </>
  );
}
