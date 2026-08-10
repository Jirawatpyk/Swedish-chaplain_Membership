# UX / Accessibility / i18n Requirements Quality Checklist: 016 RBAC Permissions

**Purpose**: Validate that user-facing requirements (users-page retrofit, role-aware navigation, denial presentation, dashboard split) are complete, WCAG-2.1-AA-aligned, and i18n-complete across EN/TH/SV. Gate-4 artefact for the `enterprise-ux-designer` review pass (mandatory on UI-touching work).
**Created**: 2026-08-10
**Feature**: [spec.md](../spec.md) · design §7/§8 · `docs/ux-standards.md`

## Users Page Retrofit (§7.1)

- [ ] CHK049 - Are role-picker requirements complete for BOTH windows (PR 3: super_admin/admin/manager; PR 4: +marketing) including who may open the picker at all? [Completeness, Spec §FR-010, Design §7.1]
- [ ] CHK050 - Is the `finalFocus` requirement stated for EVERY dialog on the page (including the pre-existing `user-list-table.tsx` omission) with the keyboard E2E acceptance (`activeElement !== body`) as its measure? [Completeness, Spec §FR-010, §FR-015, Design §7.1]
- [x] CHK051 - Are empty/denied-state requirements defined for the users page as seen by each role that can still reach adjacent surfaces (e.g., admin sees member-account rows but no staff-role mutations — is that presentation specified, or left to implementation)? [Gap, Spec §US1-AS5] — **CLOSED 2026-08-10**: spec §FR-010 — the PAGE is `users.manage` SA-only (admin 404s, no partial view); admin's member-account ops run through the members-surface UI calling the member-target routes
- [x] CHK052 - Are error-presentation requirements defined for the last-super-admin refusal (typed error → which user-facing message, which locale keys, not a 500 toast)? [Gap, Spec §US1-AS4] — **CLOSED 2026-08-10**: spec §FR-010 — localized inline error with EN/TH/SV keys, never an unhandled 500; implemented at T048

## Navigation, Palette & Landing (§8)

- [ ] CHK053 - Is "visible set equals permitted set" stated for ALL THREE surfaces (sidebar, palette, settings index) with server-side derivation and the no-role-literals end-state? [Completeness, Spec §US4-AS1, §FR-014]
- [ ] CHK054 - Is the no-dead-links requirement measurable (every visible entry opens successfully, per persona walk) and paired with the landing invariant (≥1 widget for every staff role)? [Measurability, Spec §US4-AS2, §SC-004]
- [ ] CHK055 - Are the PR-2 interim behaviour requirements (widen three `roles:` arrays; palette must not be empty for promoted SA) distinguished from the PR-4 declarative end state so neither window is under-specified? [Clarity, Spec §FR-014, Design §6.1/§8]
- [ ] CHK056 - Are requirements defined for what a denied user sees on DIRECT navigation (404 non-disclosure page) vs what nav shows (absence) — consistent, with no surface leaking existence via UI affordances? [Consistency, Spec §FR-004, Design D9]

## Dashboard Split for Marketing (§4.3)

- [ ] CHK057 - Is "no degenerate layout" for the engagement-only dashboard operationalised (no empty grid holes, no dead widget links) rather than aesthetic prose? [Measurability, Spec §US3-AS3, §FR-012]
- [ ] CHK058 - Are loading/skeleton requirements referenced for the split snapshot loaders (shimmer per ux-standards §2.1), or explicitly inherited from existing dashboard behaviour? [Gap, Spec §FR-012]

## Internationalization (EN/TH/SV)

- [ ] CHK059 - Are ALL new user-facing strings enumerated (5 role display names, users-page picker labels, denial/refusal messages) with the three-locale requirement and `check:i18n` as the gate? [Completeness, Spec §FR-015]
- [ ] CHK060 - Are Thai-typography constraints honoured in the new surfaces' requirements (no italic on TH role names/labels; length variance accommodated in the role-picker and nav)? [Coverage, memory: no-italic-on-Thai, Constitution §V]
- [ ] CHK061 - Is fallback behaviour specified for a missing TH/SV role-name key (EN fallback + CI warning), consistent with the repo's i18n policy? [Consistency, Constitution §V]

## Accessibility (WCAG 2.1 AA)

- [ ] CHK062 - Are a11y requirements scoped to EVERY changed surface (users page, nav, palette, settings index, dashboard split) via the axe sweep requirement, not just the users page? [Coverage, Spec §FR-015]
- [ ] CHK063 - Are keyboard-navigation requirements complete for the role picker itself (focus order, ESC/confirm semantics per existing dialog standards)? [Gap, Spec §FR-010, ux-standards §keyboard]
- [ ] CHK064 - Do the requirements state target-size and focus-visibility conformance for any NEW interactive elements (picker options, settings-index entries), or explicitly inherit the shared component library's conformance? [Completeness, Constitution §VI]

## Notes

- `enterprise-ux-designer` pass required on PR 3 + PR 4 regardless of checklist state (repo standing rule).
