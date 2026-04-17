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

  it('applies the 42rem max-width token (--layout-max-width-form)', () => {
    const { container } = render(
      <FormContainer>
        <p>body</p>
      </FormContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toMatch(/layout-max-width-form/);
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
