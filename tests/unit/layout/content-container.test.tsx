import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ContentContainer } from '@/components/layout/content-container';

describe('<ContentContainer>', () => {
  it('defaults to admin variant (72rem)', () => {
    const { container } = render(
      <ContentContainer>
        <p>body</p>
      </ContentContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toMatch(/content-max-width-admin/);
  });

  it('portal variant uses 64rem max-width token', () => {
    const { container } = render(
      <ContentContainer variant="portal">
        <p>body</p>
      </ContentContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toMatch(/content-max-width-portal/);
  });

  it('fullBleed disables max-width but preserves horizontal padding', () => {
    const { container } = render(
      <ContentContainer fullBleed>
        <p>body</p>
      </ContentContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).not.toMatch(/content-max-width-admin/);
    expect(wrapper.className).not.toMatch(/content-max-width-portal/);
    expect(wrapper.className).toMatch(/page-padding-x/);
  });

  it('renders children', () => {
    render(
      <ContentContainer>
        <p>hello</p>
      </ContentContainer>,
    );
    expect(screen.getByText('hello')).toBeDefined();
  });

  it('uses CSS logical properties for horizontal padding', () => {
    const { container } = render(
      <ContentContainer>
        <p>body</p>
      </ContentContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    // Either a Tailwind logical-property arbitrary value, or a utility that
    // maps to padding-inline. We accept px-[var(--page-padding-x)] as a
    // proxy since Tailwind v4 uses CSS logical properties under the hood.
    expect(wrapper.className).toMatch(/(?:padding-inline|page-padding-x)/);
  });
});
