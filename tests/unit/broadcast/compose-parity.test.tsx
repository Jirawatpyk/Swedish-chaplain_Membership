/**
 * F119 T137 / T145 (US6-AS5, FR-039) — the writing tool is the SAME tool.
 *
 * "The writing tool MUST be the same for members writing an original and for
 * marketing formatting a version." `proxy-compose-parity.test.tsx` states that
 * as seven hand-written `it` titles — template picker, subject counter,
 * preview, dirty guard, draft save, inline images, allowance. That list is a
 * snapshot of what someone remembered in September 2026: the EIGHTH feature,
 * added to the member form next year, is parity nobody notices is missing.
 *
 * Senior-tester review H4 makes the claim structural instead. Both forms are
 * rendered under IDENTICAL providers and stubs and the same probe is collected
 * from each tree:
 *
 *   1. the set of `data-compose-feature` markers — the composed features;
 *   2. the multiset of interactive control ROLES — every focusable affordance,
 *      marked or not, so a bare `<button>` added to one form is caught too.
 *
 * Copy differs by design (the member form speaks `portal.broadcasts.compose.*`,
 * the staff form `admin.broadcasts.proxyCompose.*`), so accessible NAMES are
 * deliberately not part of the probe — only the shape is.
 *
 * `STAFF_ONLY` is the declared diff: the member picker exists only on the
 * compose-on-behalf form, because only that form chooses whose E-Blast this
 * is. Anything else that diverges is a finding, not a fixture.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ComposeForm } from '@/components/broadcast/compose-form';
import { ProxyComposeForm } from '@/components/broadcast/proxy-compose-form';
import type { ComposeTemplateOption } from '@/components/broadcast/compose/template-picker-field';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// The live recipient count is a debounced fetch; stubbed IDENTICALLY for both
// so any difference the probe reports comes from the forms, not the stub.
vi.mock('@/components/broadcast/recipient-count', () => ({
  useRecipientCount: () => ({ status: 'idle' }),
  RecipientCountLine: () => null,
}));

// The member picker is the declared staff-only extra; a single named button
// stands in for its combobox so the diff it contributes is exactly one entry.
// It also fires `onSelect`, because the staff form only shows the proxied
// member's allowance once a member is named — the probe has to compare the two
// forms at the SAME point in the flow, not compare "before a member is picked"
// against "the member's own form".
vi.mock('@/components/broadcast/member-picker', () => ({
  MemberPicker: (props: {
    onSelect: (m: {
      memberId: string;
      companyName: string;
      hasPrimaryContactEmail: boolean;
    }) => void;
  }) => (
    <button
      type="button"
      data-compose-feature="member-picker"
      onClick={() =>
        props.onSelect({
          memberId: '22222222-2222-2222-2222-222222222222',
          companyName: 'Acme Co',
          hasPrimaryContactEmail: true,
        })
      }
    >
      pick-member
    </button>
  ),
}));

vi.mock('@/components/ui/tiptap-loader', () => ({
  loadTiptapEditor: () =>
    function TiptapStub(props: {
      initialHtml: string;
      onChange: (html: string) => void;
    }): React.ReactElement {
      return (
        <textarea
          aria-label="Message body"
          defaultValue={props.initialHtml}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
    },
}));

const TEMPLATE: ComposeTemplateOption = {
  id: 't1',
  name: 'Welcome',
  locale: 'en',
  isSeeded: false,
  subject: 'Template subject',
  bodyHtml: '<p>Template body</p>',
};

/** Features that legitimately exist on the STAFF form only, with the reason. */
const STAFF_ONLY: Readonly<Record<string, string>> = {
  'member-picker':
    'only the compose-on-behalf form chooses WHOSE E-Blast this is; the member form already knows.',
};

/** Roles that only the staff form contributes, and why. */
const STAFF_ONLY_ROLES: Readonly<Record<string, string>> = {
  button: 'the member-picker trigger (1) — see STAFF_ONLY.',
};

const INTERACTIVE_ROLES = [
  'button',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'link',
  'switch',
  'slider',
  'spinbutton',
] as const;

function markers(root: HTMLElement): string[] {
  return [
    ...new Set(
      [...root.querySelectorAll('[data-compose-feature]')].map(
        (el) => el.getAttribute('data-compose-feature')!,
      ),
    ),
  ].sort();
}

function roleCounts(root: HTMLElement): Record<string, number> {
  const out: Record<string, number> = {};
  for (const role of INTERACTIVE_ROLES) {
    const n = [...root.querySelectorAll('*')].filter(
      (el) => el.getAttribute('role') === role,
    ).length;
    if (n > 0) out[role] = n;
  }
  // Native controls carry their role implicitly — count the elements, not the
  // attribute, or every `<button>` in the tree is invisible to this probe.
  const native: ReadonlyArray<readonly [string, string]> = [
    ['button', 'button:not([role])'],
    ['textbox', 'input[type="text"]:not([role]), input:not([type]):not([role]), textarea:not([role])'],
    ['checkbox', 'input[type="checkbox"]:not([role])'],
    ['radio', 'input[type="radio"]:not([role])'],
    ['link', 'a[href]:not([role])'],
  ];
  for (const [role, selector] of native) {
    const n = root.querySelectorAll(selector).length;
    if (n > 0) out[role] = (out[role] ?? 0) + n;
  }
  return out;
}

function renderMember(): HTMLElement {
  const { container } = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposeForm
        audienceCeiling={5000}
        audienceMode="primary_only"
        templates={[TEMPLATE]}
      />
    </NextIntlClientProvider>,
  );
  return container;
}

function renderStaff(): HTMLElement {
  const { container } = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ProxyComposeForm audienceCeiling={5000} templates={[TEMPLATE]} />
    </NextIntlClientProvider>,
  );
  // Name the member, so both trees are compared at the same point in the flow.
  act(() => {
    fireEvent.click(container.querySelector('[data-compose-feature="member-picker"]')!);
  });
  return container;
}

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params?: PointerEventInit) {
        super(type, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('T137 / T145 — FR-039 parity is a set, not a list of remembered features', () => {
  it('the probe actually found the features (a probe that finds nothing must not read as parity)', () => {
    const member = markers(renderMember());
    expect(member.length).toBeGreaterThanOrEqual(6);
    // The named ones, so a renamed marker cannot quietly empty the set.
    expect(member).toEqual(
      expect.arrayContaining(['body-editor', 'save-draft', 'subject', 'submit']),
    );
  });

  it('both forms compose the SAME feature set, apart from the declared staff-only extras', () => {
    const memberFeatures = markers(renderMember());
    cleanup();
    const staffFeatures = markers(renderStaff());

    const staffExtra = staffFeatures.filter((f) => !memberFeatures.includes(f));
    const memberExtra = memberFeatures.filter((f) => !staffFeatures.includes(f));

    expect(
      staffExtra,
      'a feature on the staff form only — declare it in STAFF_ONLY with the reason, or give the member form the same tool',
    ).toEqual(Object.keys(STAFF_ONLY).sort());
    expect(
      memberExtra,
      'a feature the member has and marketing does not — FR-039 says the writing tool is the SAME tool',
    ).toEqual([]);
  });

  it('neither form carries an interactive control the other lacks', () => {
    const memberRoles = roleCounts(renderMember());
    cleanup();
    const staffRoles = roleCounts(renderStaff());

    // The staff form's ONE extra affordance is the member picker.
    const expectedStaff = { ...memberRoles };
    for (const role of Object.keys(STAFF_ONLY_ROLES)) {
      expectedStaff[role] = (expectedStaff[role] ?? 0) + 1;
    }

    expect(
      staffRoles,
      'an affordance on one form only — marked or not. Either give the other form the same one, or declare it.',
    ).toEqual(expectedStaff);
  });

  it('every declared staff-only extra is actually present (the allow-list cannot rot)', () => {
    renderStaff();
    for (const feature of Object.keys(STAFF_ONLY)) {
      expect(
        document.querySelector(`[data-compose-feature="${feature}"]`),
        `${feature} is declared staff-only but no longer renders — delete the entry`,
      ).not.toBeNull();
    }
  });
});
