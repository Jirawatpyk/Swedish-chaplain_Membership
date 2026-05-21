"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  // WCAG 2.1 SC 2.1.1 (Keyboard) + axe-core `scrollable-region-focusable`
  // closure 2026-05-21 (E2E template-library a11y blocker): when the
  // table overflows horizontally on narrow viewports, keyboard users
  // need a way to pan-scroll via arrow keys. `tabIndex={0}` makes the
  // scrollable container focus-able; once focused, arrow keys natively
  // pan-scroll the region. `role="region"` + `aria-label` give it a
  // landmark identity in screen-reader navigation. Operators with
  // multiple tables on a page SHOULD override `aria-label` per table
  // (e.g., "Membership plans table") via the prop spread below — this
  // primitive provides a sensible default so the rule never fails out
  // of the box. The focus-visible:ring-3 mirrors the F4 form-input
  // focus token so the keyboard-focus indicator is consistent.
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      tabIndex={0}
      role="region"
      aria-label="Data table"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      // Sticky so column labels stay visible during horizontal scroll on narrow viewports.
      // bg-card matches the surrounding <Card> token in both light + dark
      // modes (--card vs --background differ in OKLCH lightness; bg-background
      // made the sticky header float visually inside cards).
      className={cn("sticky top-0 z-10 bg-card [&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      // focus-within mirrors hover so keyboard users get the same row-highlight affordance.
      className={cn(
        "h-[var(--table-row-height)] border-b transition-colors hover:bg-[var(--table-row-hover-bg)] focus-within:bg-[var(--table-row-hover-bg)] has-aria-expanded:bg-[var(--table-row-hover-bg)] data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-[var(--table-row-height)] px-[var(--table-cell-padding-x)] text-left align-middle text-caption font-medium uppercase tracking-wide whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-[var(--table-cell-padding-x)] py-[var(--table-cell-padding-y)] align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
