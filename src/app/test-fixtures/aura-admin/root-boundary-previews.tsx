'use client';

/**
 * Spec 122 US12d-1 — the staff root error boundary in the preview harness
 * (`aura-admin?view=root-error`). An `Error` cannot cross from the server page
 * to a client component, so this client wrapper builds it.
 */
import AdminError from '@/app/(staff)/admin/error';

export function RootErrorPreview(): React.ReactElement {
  const error = Object.assign(new Error('preview'), { digest: '3f1a9c07e2' });
  return <AdminError error={error} reset={() => {}} />;
}
