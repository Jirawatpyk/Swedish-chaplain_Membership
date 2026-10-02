import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { FormContainer } from '@/components/layout/form-container';

describe('<FormContainer>', () => {
  it('renders children', () => {
    render(
      <FormContainer>
        <p>hello</p>
      </FormContainer>,
    );
    expect(screen.getByText('hello')).toBeDefined();
  });

  it('sets data-slot="layout-container" and data-variant="form"', () => {
    const { container } = render(
      <FormContainer>
        <p>body</p>
      </FormContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute('data-slot')).toBe('layout-container');
    expect(wrapper.getAttribute('data-variant')).toBe('form');
  });

  it('is AURA\'s narrow Container (720px), centred by default', () => {
    const { container } = render(
      <FormContainer>
        <p>body</p>
      </FormContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper).toHaveClass('aura-container', 'is-narrow');
    expect(wrapper).not.toHaveClass('is-start');
    expect(wrapper.className).not.toMatch(/layout-max-width/);
  });

  it('align="start" puts the column at the page\'s start edge (the staff forms)', () => {
    const { container } = render(
      <FormContainer align="start">
        <p>body</p>
      </FormContainer>,
    );
    expect(container.firstElementChild).toHaveClass('aura-container', 'is-narrow', 'is-start');
  });

  it('keeps the app\'s own page gutter on top of AURA\'s', () => {
    const { container } = render(
      <FormContainer>
        <p>body</p>
      </FormContainer>,
    );
    expect((container.firstElementChild as HTMLElement).className).toContain('px-[var(--page-padding-x)]');
  });

  it('forwards aria-busy, as the detail and table containers do', () => {
    const { container } = render(
      <FormContainer aria-busy="true">
        <p>body</p>
      </FormContainer>,
    );
    expect(container.firstElementChild).toHaveAttribute('aria-busy', 'true');
  });

  it('merges custom className', () => {
    const { container } = render(
      <FormContainer className="custom-class">
        <p>body</p>
      </FormContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toMatch(/custom-class/);
  });

  it('does NOT own horizontal scroll (overflow-x must remain visible — FR-015)', () => {
    const { container } = render(
      <FormContainer>
        <p>body</p>
      </FormContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).not.toMatch(/overflow-x-(?:auto|scroll|hidden)/);
    expect(wrapper.className).not.toMatch(/overflow-(?:auto|scroll|hidden)/);
  });
});
