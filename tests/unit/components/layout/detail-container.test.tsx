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

  // Round-8 R8 review fix (2026-05-13, closes S-3 gap): the aria-busy
  // pass-through prop landed in round-7 R2-B for loading.tsx skeleton
  // signalling but had no behavioural test. A future refactor that
  // drops the prop destructure or fails to set it on the underlying
  // <div> would regress AT users' "busy" announcement during shimmer.
  it('forwards aria-busy="true" prop to the underlying div', () => {
    const { container } = render(
      <DetailContainer aria-busy="true">
        <p>body</p>
      </DetailContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute('aria-busy')).toBe('true');
  });

  it('omits aria-busy when prop not provided', () => {
    const { container } = render(
      <DetailContainer>
        <p>body</p>
      </DetailContainer>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute('aria-busy')).toBeNull();
  });
});
