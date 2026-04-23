# Chamber-OS — SaaS Membership Platform

SaaS membership management for chambers of commerce. First tenant: **SweCham / TSCC** at `swecham.zyncdata.app`.

See [`CLAUDE.md`](./CLAUDE.md) for the canonical project overview (tenancy model, tech stack, governance, commands).

## Getting Started

```bash
pnpm install
pnpm dev        # Next.js + Turbopack on http://localhost:3100
```

## Per-feature developer onboarding

- **F5 Online Payment (Stripe + PromptPay)** — local Stripe CLI setup + webhook forwarding: see [`specs/009-online-payment/quickstart.md`](./specs/009-online-payment/quickstart.md)
- **F4 Invoices & Receipts** — PDF rendering + Vercel Blob setup: see [`specs/007-invoices-receipts/quickstart.md`](./specs/007-invoices-receipts/quickstart.md)
- **F1 Auth & RBAC** — session + invitation flow: see [`specs/001-auth-rbac/quickstart.md`](./specs/001-auth-rbac/quickstart.md)

## Commands

See [`CLAUDE.md` § Commands](./CLAUDE.md) for the full list (lint, typecheck, test, coverage, migrations, i18n check, layout check).

## Spec Kit workflow

Every feature flows through 10 gates: `/speckit.specify` → `/speckit.clarify` → `/speckit.plan` → `/speckit.checklist` → `/speckit.tasks` → `/speckit.analyze` → `/speckit.implement` → `/speckit.verify` → `/speckit.review` → `/speckit.ship`.

Spec artefacts live under [`specs/<nnn-feature>/`](./specs/).
