/**
 * AuraBridge — the one place AURA learns the user's language, calendar, time
 * zone, router link and density (spec 122 FR-005, contracts/aura-bridge.md).
 */
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useAuraLocale } from '@jirawatpyk/aura-react';
import { AuraBridge, AuraDensity } from '@/components/providers/aura-bridge';
import { toast } from '@/lib/toast';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a data-router-link="" href={href} {...rest}>
      {children}
    </a>
  ),
}));

function Probe(): React.ReactElement {
  const { locale, calendar, timeZone, density, linkComponent } = useAuraLocale();
  return (
    <output
      data-testid="probe"
      data-locale={locale ?? ''}
      data-calendar={calendar ?? ''}
      data-tz={timeZone ?? ''}
      data-density={density ?? ''}
      data-link={linkComponent ? 'yes' : 'no'}
    />
  );
}

const probe = () => screen.getByTestId('probe');

describe('<AuraBridge>', () => {
  it.each([
    ['th', 'buddhist'],
    ['en', 'gregory'],
    ['sv', 'gregory'],
  ] as const)('locale %s → calendar %s (Buddhist Era is display-only, for Thai)', (locale, calendar) => {
    render(
      <AuraBridge locale={locale} timeZone="Asia/Bangkok">
        <Probe />
      </AuraBridge>,
    );
    expect(probe()).toHaveAttribute('data-locale', locale);
    expect(probe()).toHaveAttribute('data-calendar', calendar);
  });

  it('passes the tenant time zone and the router link', () => {
    render(
      <AuraBridge locale="en" timeZone="Asia/Bangkok">
        <Probe />
      </AuraBridge>,
    );
    expect(probe()).toHaveAttribute('data-tz', 'Asia/Bangkok');
    expect(probe()).toHaveAttribute('data-link', 'yes');
  });

  it('AuraDensity sets the portal density and keeps the language, calendar, time zone and link from the bridge', () => {
    render(
      <AuraBridge locale="th" timeZone="Asia/Bangkok">
        <AuraDensity density="compact">
          <Probe />
        </AuraDensity>
      </AuraBridge>,
    );
    expect(probe()).toHaveAttribute('data-density', 'compact');
    expect(probe()).toHaveAttribute('data-locale', 'th');
    expect(probe()).toHaveAttribute('data-calendar', 'buddhist');
    expect(probe()).toHaveAttribute('data-tz', 'Asia/Bangkok');
    expect(probe()).toHaveAttribute('data-link', 'yes');
  });

  it('mounts the one Toaster, top-centre, and the facade toasts land in it', () => {
    render(
      <AuraBridge locale="en" timeZone="Asia/Bangkok">
        <p>page</p>
      </AuraBridge>,
    );
    const regions = screen.getAllByRole('region', { name: /notifications/i });
    expect(regions).toHaveLength(1);
    // Top-centre below the tallest top bar — the portal header's 72px (AURA 5.6 position + offset, handoff #54).
    expect(regions[0]).toHaveClass('is-top', 'is-center');
    expect(regions[0]!.style.getPropertyValue('--aura-toaster-offset')).toBe('80px');

    const ids: string[] = [];
    act(() => {
      ids.push(toast.success('Plan saved'), toast.error('Could not save'));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Plan saved');
    // The danger tone is announced assertively.
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save');
    // AURA keeps toasts in module state; clear them for the next test.
    act(() => ids.forEach((id) => toast.dismiss(id)));
  });

  it('Alt+T moves keyboard focus to the newest toast — its action, else its close button', () => {
    render(
      <AuraBridge locale="en" timeZone="Asia/Bangkok">
        <button type="button">page</button>
      </AuraBridge>,
    );
    const ids: string[] = [];
    act(() => {
      ids.push(toast.info('Older'));
      ids.push(toast.success('Member removed', { action: { label: 'Undo' } }));
    });
    fireEvent.keyDown(document, { key: 't', code: 'KeyT', altKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }));

    act(() => toast.dismiss(ids.pop()!));
    fireEvent.keyDown(document, { key: '†', code: 'KeyT', altKey: true }); // macOS Option+T
    expect(document.activeElement).toHaveAccessibleName(/dismiss|close/i);
    act(() => ids.forEach((id) => toast.dismiss(id)));
  });

  it('reusing an id replaces that toast in place instead of stacking a second one', () => {
    render(
      <AuraBridge locale="en" timeZone="Asia/Bangkok">
        <p>page</p>
      </AuraBridge>,
    );
    act(() => {
      toast.loading('Uploading', { id: 'upload' });
      toast.success('Uploaded', { id: 'upload' });
    });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Uploaded');
    act(() => toast.dismiss('upload'));
  });
});
