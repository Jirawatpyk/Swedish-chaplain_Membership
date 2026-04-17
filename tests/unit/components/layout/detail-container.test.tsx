import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DetailContainer } from '@/components/layout/detail-container';

describe('<DetailContainer>', () => {
  it('renders children', () => {
    render(
      <DetailContainer>
        <p>hello</p>
      </DetailContainer>,
    );
    expect(screen.getByText('hello')).toBeDefined();
  });

  it('sets data-slot="layout-container" and data-variant="detail"', () => {
    const { container } = render(
      <DetailContainer>
        <p>body</p>
      </DetailContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute('data-slot')).toBe('layout-container');
    expect(wrapper.getAttribute('data-variant')).toBe('detail');
  });

  it('applies the 72rem max-width token (--layout-max-width-detail)', () => {
    const { container } = render(
      <DetailContainer>
        <p>body</p>
      </DetailContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toMatch(/layout-max-width-detail/);
  });

  it('merges custom className', () => {
    const { container } = render(
      <DetailContainer className="custom-class">
        <p>body</p>
      </DetailContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toMatch(/custom-class/);
  });

  it('does NOT own horizontal scroll (overflow-x must remain visible — FR-015)', () => {
    const { container } = render(
      <DetailContainer>
        <p>body</p>
      </DetailContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).not.toMatch(/overflow-x-(?:auto|scroll|hidden)/);
    expect(wrapper.className).not.toMatch(/overflow-(?:auto|scroll|hidden)/);
  });
});
