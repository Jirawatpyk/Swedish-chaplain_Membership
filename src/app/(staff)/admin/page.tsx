import type { Metadata } from 'next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';

/**
 * Staff home page (T076) — placeholder for the MVP.
 *
 * Future phases will replace this with the actual staff dashboard:
 *   - F3 — Members & Contacts list
 *   - F4 — Invoices & receipts
 *   - F6/F7 — Events & registration
 *   - F9 — unified admin dashboard + audit log viewer + sidebar nav
 *
 * For F1 (MVP) it just confirms the sign-in flow worked and shows the
 * authenticated user their name + the placeholder roadmap. Links to
 * F1-completed sub-pages (`/admin/users`, `/admin/account`) are
 * intentionally NOT surfaced here — the proper nav shell lands in F9,
 * and adding a transient quick-action row now would only be removed
 * later. F1 admins reach `/admin/users` by URL and `/admin/account`
 * via the UserMenu dropdown (ux-standards § 8.1).
 */
export const metadata: Metadata = {
  title: 'Staff home',
};

export default async function StaffHomePage() {
  const { user } = await requireSession('staff');

  return (
    <ContentContainer>
      <PageHeader
        title={`Welcome${user.displayName ? `, ${user.displayName}` : ''}`}
        subtitle={`You are signed in as ${user.role}.`}
      />

      <Card>
        <CardHeader>
          <CardTitle>What ships next</CardTitle>
          <CardDescription>F1 (auth) is the foundation. The rest of the staff workspace lands in upcoming phases.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-3 text-body">
            <li className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-caption font-medium">F3</span>
              <span>Member &amp; contact directory</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-caption font-medium">F4</span>
              <span>Invoices &amp; receipts (Thai tax compliant)</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-caption font-medium">F6</span>
              <span>Events &amp; registration</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-caption font-medium">F5</span>
              <span>Online membership renewal &amp; payments</span>
            </li>
          </ul>
        </CardContent>
      </Card>
    </ContentContainer>
  );
}
