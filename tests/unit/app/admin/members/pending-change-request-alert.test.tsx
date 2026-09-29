/**
 * 122 US5b-1 (UX review M9, board `Admin-member-detail-mobile`): a change
 * request awaiting review shows as an info alert above the figures, with
 * "Review" taking staff to that request.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: enMessages, namespace: namespace as never }),
}));

const { PendingChangeRequestAlert } = await import(
  '@/app/(staff)/admin/members/[memberId]/_components/member-change-requests-section'
);

const CR = enMessages.admin.members.changeRequests;

describe('PendingChangeRequestAlert', () => {
  it('an info alert saying a request awaits review, with Review to that request', async () => {
    render((await PendingChangeRequestAlert({ requestId: 'cr-9' })) as ReactElement);
    const alert = screen.getByRole('status');
    expect(alert).toHaveTextContent(CR.pendingAlert);
    expect(screen.getByRole('link', { name: CR.review })).toHaveAttribute('href', '/admin/change-requests/cr-9');
  });
});
