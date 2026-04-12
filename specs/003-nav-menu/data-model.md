# Data Model: Navigation Menu (003-nav-menu)

**Date**: 2026-04-12

## Overview

This feature is **pure presentation layer** — no database tables, migrations, or server-side state are added. All data structures are TypeScript types used at build time and runtime in the client.

## Client-Side Types

### NavItem

Represents a single navigation link.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| titleKey | string | Yes | i18n key for the label (e.g., `nav.staff.dashboard`) |
| icon | LucideIcon | Yes | Icon component from lucide-react |
| href | string | Yes | Target URL path (e.g., `/admin/plans`) |
| activePattern | string | Yes | URL prefix for active-state matching (e.g., `/admin/plans`) |
| roles | Role[] | No | If set, item is visible only to these roles. If omitted, visible to all authenticated users. |

### NavGroup

Represents an expandable/collapsible group containing child NavItems.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| titleKey | string | Yes | i18n key for the group label (e.g., `nav.staff.settings`) |
| icon | LucideIcon | Yes | Icon for the group header |
| activePattern | string | Yes | URL prefix — group auto-expands when any child or this prefix matches |
| children | NavItem[] | Yes | Child navigation items |
| roles | Role[] | No | If set, group is visible only to these roles |

### NavSection

A logical grouping of NavItems and NavGroups with an optional visual header.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| titleKey | string | No | i18n key for the section header. If omitted, no header is rendered. |
| items | (NavItem \| NavGroup)[] | Yes | Items in this section |

### NavConfig

Top-level configuration for a portal's navigation.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| sections | NavSection[] | Yes | Ordered list of nav sections |

## Relationships

```
NavConfig
  └── NavSection[]
        ├── titleKey? (optional section header)
        └── items: (NavItem | NavGroup)[]
              ├── NavItem → href (page link)
              └── NavGroup
                    └── children: NavItem[] (sub-items)
```

## State

| State | Storage | Scope | Default |
|-------|---------|-------|---------|
| Sidebar collapsed/expanded | localStorage (`sidebar-collapsed`) | Per-browser, persists across sessions | `false` (expanded) |
| NavGroup expanded/collapsed | Component state (auto-managed) | Per-session, auto-expands on active match | Collapsed unless active child |
| Mobile drawer open/closed | Component state | Transient | Closed |

## No Database Changes

- No new tables
- No new migrations
- No Drizzle schema changes
- No tenant-scoped data
