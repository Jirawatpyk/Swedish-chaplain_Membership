---
paths:
  - "src/modules/auth/**"
  - "src/proxy.ts"
  - "src/app/*/forgot-password/**"
  - "src/app/*/reset-password/**"
  - "src/app/*/invite/**"
  - "src/app/*/email-change/**"
  - "src/app/*/email-verification/**"
  - "src/app/*/*/sign-in/**"
  - "src/app/*/admin/users/**"
  - "src/app/api/auth/**"
  - "src/components/auth/**"
  - "tests/**/auth/**"
---

# Auth & RBAC (F1 `001-auth-rbac`, 016 RBAC v2)

Security-sensitive: ≥2 reviewers, one signs `specs/001-auth-rbac/security.md` § 5. Review with `security-engineer`.

- **F1 shape**: email+password only, invitation-based accounts, custom session auth (Lucia v3 guide pattern, argon2id via `@node-rs/argon2`), 30 min idle / 12 h absolute TTL, portals `/admin` (staff) and `/portal` (member) plus shared `/forgot-password` and `/invite/[token]`. Threat model T-01…T-16 in `specs/001-auth-rbac/security.md`.
- **016 RBAC v2**: role pgEnum `+= 'super_admin','marketing'` · `audit_event_type += 'permission_denied'` · `users_last_admin_guard()` rewritten UNION→strict. The permission catalogue and `ROLE_BUNDLES` are pure Domain data in `src/modules/auth/domain/permissions/`; the evaluator is single-leg `hasPermission(role, key)`.
- **`ROLE_BUNDLES` is not the whole model**: super-admin keys come from the EVALUATOR, so ask it, never read the bundle.
- `/admin/users` is `superAdminOnly` — an e2e admin sees "Page not available" there.
- Pre-push guards: `check:staff-page-guard`, `check:api-route-guard`, `check:authorization-role-reads`, `check:actor-role-truth`.
- Rate limits that protect security use an atomic check, never a peek.
- Coverage: **100% branch** on sign-in, change-password, reset-password, role policy, sign-out.
