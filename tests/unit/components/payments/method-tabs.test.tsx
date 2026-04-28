/**
 * Unit tests for <MethodTabs> — G2 T075.
 * Contract: specs/009-online-payment (FR-002, a11y name/role/value).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import {
  MethodTabs,
  type MethodTabsProps,
} from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/method-tabs';

const messages = {
  portal: {
    payment: {
      methods: {
        card: 'Card',
        promptpay: 'PromptPay',
        cardAriaLabel: 'Card — switch payment method',
        promptpayAriaLabel: 'PromptPay — switch payment method',
        cardPlaceholder: 'Card form coming in G3',
        promptpayPlaceholder: 'PromptPay coming in Phase 4',
      },
    },
  },
};

function renderWithIntl(props: MethodTabsProps) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MethodTabs {...props} />
    </NextIntlClientProvider>,
  );
}

describe('<MethodTabs>', () => {
  it('renders 2 tabs when both methods are enabled', () => {
    renderWithIntl({
      enabledMethods: ['card', 'promptpay'],
      activeMethod: 'card',
      onMethodChange: vi.fn(),
    });
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(
      screen.getByRole('tab', { name: 'Card — switch payment method' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('tab', { name: 'PromptPay — switch payment method' }),
    ).toBeTruthy();
  });

  it('renders a non-tab heading when exactly one method is enabled (FR-002)', () => {
    const { container } = renderWithIntl({
      enabledMethods: ['card'],
      activeMethod: 'card',
      onMethodChange: vi.fn(),
    });
    expect(screen.queryByRole('tab')).toBeNull();
    expect(
      container.querySelector('[data-testid="pay-sheet-single-method"]'),
    ).not.toBeNull();
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Card');
  });

  it('calls onMethodChange("promptpay") when the PromptPay tab is clicked', () => {
    const onMethodChange = vi.fn();
    renderWithIntl({
      enabledMethods: ['card', 'promptpay'],
      activeMethod: 'card',
      onMethodChange,
    });
    fireEvent.click(
      screen.getByRole('tab', { name: 'PromptPay — switch payment method' }),
    );
    expect(onMethodChange).toHaveBeenCalledWith('promptpay');
  });

  it('calls onMethodChange("card") when the Card tab is clicked', () => {
    const onMethodChange = vi.fn();
    renderWithIntl({
      enabledMethods: ['card', 'promptpay'],
      activeMethod: 'promptpay',
      onMethodChange,
    });
    fireEvent.click(
      screen.getByRole('tab', { name: 'Card — switch payment method' }),
    );
    expect(onMethodChange).toHaveBeenCalledWith('card');
  });

  it('each tab exposes a localized aria-label for screen readers', () => {
    renderWithIntl({
      enabledMethods: ['card', 'promptpay'],
      activeMethod: 'card',
      onMethodChange: vi.fn(),
    });
    const cardTab = screen.getByRole('tab', { name: 'Card — switch payment method' });
    const ppTab = screen.getByRole('tab', {
      name: 'PromptPay — switch payment method',
    });
    expect(cardTab.getAttribute('aria-label')).toBe('Card — switch payment method');
    expect(ppTab.getAttribute('aria-label')).toBe(
      'PromptPay — switch payment method',
    );
  });

  // -- keepMounted polish (commit 018b9cf) --------------------------------
  it('keeps BOTH panels mounted so Stripe iframe survives tab swap (commit 018b9cf)', () => {
    // T082 empirical finding: before `keepMounted`, toggling
    // Card → PromptPay → Card unmounted the card panel, tore down the
    // Stripe <Elements> tree, and forced a fresh iframe load on every
    // return — visible as a 300ms skeleton floor + button fade-in
    // "flash". The fix mounts both panels; inactive one is hidden.
    renderWithIntl({
      enabledMethods: ['card', 'promptpay'],
      activeMethod: 'card',
      onMethodChange: vi.fn(),
      cardPanel: <div data-testid="card-stub">card-panel</div>,
      promptPayPanel: <div data-testid="promptpay-stub">promptpay-panel</div>,
    });
    // Both slots ARE in the DOM even though only card is selected.
    expect(screen.getByTestId('card-stub')).toBeTruthy();
    expect(screen.getByTestId('promptpay-stub')).toBeTruthy();
  });

  it('tabs are wired for keyboard navigation via the Base-UI Tabs primitive', () => {
    // Base-UI Tabs owns arrow-key nav. We assert the integration surface:
    // - both tabs render with role="tab"
    // - the selected tab has tabindex="0" (active tabstop)
    // - the unselected tab has tabindex="-1" (reachable only via arrow keys)
    // The actual ArrowRight keydown handler is covered in the Base-UI test
    // suite; re-testing it here would only verify the primitive.
    renderWithIntl({
      enabledMethods: ['card', 'promptpay'],
      activeMethod: 'card',
      onMethodChange: vi.fn(),
    });
    const cardTab = screen.getByRole('tab', { name: 'Card — switch payment method' });
    const ppTab = screen.getByRole('tab', {
      name: 'PromptPay — switch payment method',
    });
    expect(cardTab.getAttribute('tabindex')).toBe('0');
    expect(ppTab.getAttribute('tabindex')).toBe('-1');
  });
});
