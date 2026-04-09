import type { Metadata } from 'next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireSession } from '@/lib/auth-session';

/**
 * Staff home page (T076) — placeholder for the MVP.
 *
 * Future phases will replace this with the actual staff dashboard:
 *   - F3 — Members & Contacts list
 *   - F4 — Invoices & receipts
 *   - F6/F7 — Events & registration
 *
 * For F1 (MVP) it just confirms the sign-in flow worked and shows the
 * authenticated user their name + the placeholder roadmap.
 */
export const metadata: Metadata = {
  title: 'Staff home',
};

export default async function StaffHomePage() {
  const { user } = await requireSession('staff');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome{user.displayName ? `, ${user.displayName}` : ''}
        </h1>
        <p className="text-sm text-muted-foreground">
          You are signed in as <strong>{user.role}</strong>.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>What ships next</CardTitle>
          <CardDescription>F1 (auth) is the foundation. The rest of the staff workspace lands in upcoming phases.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-3 text-sm">
            <li className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">F3</span>
              <span>Member &amp; contact directory</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">F4</span>
              <span>Invoices &amp; receipts (Thai tax compliant)</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">F6</span>
              <span>Events &amp; registration</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">F5</span>
              <span>Online membership renewal &amp; payments</span>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
