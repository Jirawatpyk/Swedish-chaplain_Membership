// @vitest-environment jsdom
/**
 * Spec 122 PR C (/code-review round 2) — the "acknowledged in this tab" flag
 * is keyed by the member (company) it was recorded for. Sign-out and sign-in
 * are client navigations, so a flag for company A must not hide company B's
 * rules or banner when B signs in on the same tab.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  announceBroadcastsAcknowledged,
  resetAcknowledgedForTests,
  useBroadcastsAcknowledgedInThisTab,
} from '@/components/broadcast/acknowledgement/use-acknowledge-broadcasts-terms';

function Probe({ memberId }: { memberId: string }): React.ReactElement {
  return <span>{useBroadcastsAcknowledgedInThisTab(memberId) ? 'yes' : 'no'}</span>;
}

afterEach(() => {
  cleanup();
  resetAcknowledgedForTests();
});

describe('acknowledged in this tab', () => {
  it('is true for the member it was recorded for, and only that member', () => {
    render(
      <>
        <div data-testid="a"><Probe memberId="member-a" /></div>
        <div data-testid="b"><Probe memberId="member-b" /></div>
      </>,
    );
    act(() => announceBroadcastsAcknowledged('member-a'));
    expect(screen.getByTestId('a')).toHaveTextContent('yes');
    expect(screen.getByTestId('b')).toHaveTextContent('no');
  });
});
