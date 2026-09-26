/**
 * AuraBridge — the one place AURA learns the user's language, calendar, time
 * zone, router link and density (spec 122 FR-005, contracts/aura-bridge.md).
 */
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { AuraProvider, useAuraLocale } from '@jirawatpyk/aura-react';
import { AuraBridge } from '@/components/providers/aura-bridge';
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

  it('a nested density provider keeps the language, calendar, time zone and link from the bridge', () => {
    render(
      <AuraBridge locale="th" timeZone="Asia/Bangkok">
        <AuraProvider density="compact">
          <Probe />
        </AuraProvider>
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
    expect(regions[0]).toHaveClass('is-top');

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
});
