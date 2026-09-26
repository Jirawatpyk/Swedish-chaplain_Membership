/**
 * Spec 122 US3 — server-safe AURA markup (`aura-markup.tsx`). Server components
 * never import AURA (docs/aura-adoption.md: the barrel would ship on every
 * route), so they draw AURA's card, badge, status pill and button look with
 * its classes. Each helper is compared with AURA's own component, so the two
 * cannot drift apart unnoticed; and the module must never import AURA.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge, Button, Card, StatusPill } from '@jirawatpyk/aura-react';
import { AuraBadge, AuraCard, AuraStatusPill, auraButtonClass } from '@/components/shell/aura-markup';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('server-safe AURA markup (spec 122 US3)', () => {
  it('draws a card exactly as AURA Card does', () => {
    const props = { title: 'Organisation', description: 'Your company record', headingLevel: 2 as const };
    expect(html(<AuraCard {...props} actions={<b>x</b>} footer={<i>f</i>}>body</AuraCard>)).toBe(
      html(<Card {...props} actions={<b>x</b>} footer={<i>f</i>}>body</Card>),
    );
    expect(html(<AuraCard>only body</AuraCard>)).toBe(html(<Card>only body</Card>));
    expect(html(<AuraCard title="T" titleId="t1" as="div">b</AuraCard>)).toBe(
      html(<Card title="T" titleId="t1" as="div">b</Card>),
    );
  });

  it.each([
    [{}, 'Paid'],
    [{ tone: 'success' as const }, 'Paid'],
    [{ tone: 'danger' as const, variant: 'solid' as const }, 'Overdue'],
    [{ tone: 'neutral' as const, variant: 'outline' as const }, 'Primary'],
  ])('draws a badge exactly as AURA Badge does (%o)', (props, text) => {
    expect(html(<AuraBadge {...props}>{text}</AuraBadge>)).toBe(html(<Badge {...props}>{text}</Badge>));
  });

  it.each(['neutral', 'progress', 'ready', 'warning', 'blocked'] as const)(
    'draws a %s status pill with AURA StatusPill classes and a 12px icon',
    (tone) => {
      const ours = document.createElement('div');
      ours.innerHTML = html(<AuraStatusPill tone={tone}>Status</AuraStatusPill>);
      const theirs = document.createElement('div');
      theirs.innerHTML = html(<StatusPill tone={tone}>Status</StatusPill>);
      const a = ours.firstElementChild!;
      const b = theirs.firstElementChild!;
      expect(a.className).toBe(b.className);
      expect(a.textContent).toBe(b.textContent);
      const icon = a.querySelector('svg')!;
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.getAttribute('width')).toBe('12');
      expect(icon.getAttribute('class')).toContain('aura-icon');
    },
  );

  it.each([
    [{}, {}],
    [{ variant: 'secondary' as const }, { variant: 'secondary' as const }],
    [{ variant: 'ghost' as const, size: 'sm' as const }, { variant: 'ghost' as const, size: 'sm' as const }],
    [{ fullWidth: true }, { fullWidth: true }],
  ])('gives link buttons the classes AURA Button uses (%o)', (opts, props) => {
    const el = document.createElement('div');
    el.innerHTML = html(<Button {...props}>Go</Button>);
    expect(auraButtonClass(opts)).toBe(el.firstElementChild!.className);
  });

  it('never imports AURA, so server components can use it', () => {
    const source = readFileSync('src/components/shell/aura-markup.tsx', 'utf8');
    expect(source).not.toMatch(/from ['"]@jirawatpyk\/aura-react/);
    expect(source).not.toMatch(/^['"]use client['"]/m);
  });
});
