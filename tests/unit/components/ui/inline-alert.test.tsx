import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  InlineAlert,
  InlineAlertDescription,
  InlineAlertTitle,
} from '@/components/ui/inline-alert';

describe('<InlineAlert>', () => {
  it('renders with role=alert by default (screen-reader urgent)', () => {
    render(
      <InlineAlert tone="destructive">
        <InlineAlertTitle>Payment failed</InlineAlertTitle>
      </InlineAlert>,
    );
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('allows role override to status for non-urgent info announcements', () => {
    render(
      <InlineAlert tone="info" role="status">
        <InlineAlertDescription>Autosave enabled</InlineAlertDescription>
      </InlineAlert>,
    );
    expect(screen.getByRole('status')).toBeDefined();
  });

  it('exposes data-slot and data-tone attributes', () => {
    render(
      <InlineAlert tone="warning" data-testid="alert">
        <InlineAlertTitle>Heads up</InlineAlertTitle>
      </InlineAlert>,
    );
    const el = screen.getByTestId('alert');
    expect(el.getAttribute('data-slot')).toBe('inline-alert');
    expect(el.getAttribute('data-tone')).toBe('warning');
  });

  it('defaults to neutral tone when tone omitted', () => {
    render(
      <InlineAlert data-testid="alert">
        <InlineAlertDescription>Info</InlineAlertDescription>
      </InlineAlert>,
    );
    expect(screen.getByTestId('alert').getAttribute('data-tone')).toBe('neutral');
  });

  it('applies semantic surface classes per tone', () => {
    render(
      <InlineAlert tone="success" data-testid="alert">
        <InlineAlertTitle>Paid</InlineAlertTitle>
      </InlineAlert>,
    );
    expect(screen.getByTestId('alert').className).toMatch(/bg-success-surface/);
  });

  it('forwards a ref to the underlying div (C4 — focused-error primitive)', () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <InlineAlert ref={ref} tone="destructive">
        <InlineAlertDescription>Issue failed</InlineAlertDescription>
      </InlineAlert>,
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current?.getAttribute('data-slot')).toBe('inline-alert');
  });

  it('renders title and description subcomponents with their data-slots', () => {
    render(
      <InlineAlert tone="info">
        <InlineAlertTitle data-testid="title">Notice</InlineAlertTitle>
        <InlineAlertDescription data-testid="desc">Body</InlineAlertDescription>
      </InlineAlert>,
    );
    expect(screen.getByTestId('title').getAttribute('data-slot')).toBe(
      'inline-alert-title',
    );
    expect(screen.getByTestId('desc').getAttribute('data-slot')).toBe(
      'inline-alert-description',
    );
  });
});
