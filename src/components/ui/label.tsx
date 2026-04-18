"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Project-customised shadcn Label.
 *
 * `mb-[var(--field-label-gap)]` enforces the design-system gap between
 * the label and its associated control (token defined in globals.css).
 * Without this, raw `<Label>` + `<Input>` pairs sit flush against each
 * other and form fields look cramped — a class of regression the
 * `docs/shadcn-customizations.md` entry already documented but the
 * primitive was missing.
 */
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 mb-[var(--field-label-gap)] text-[length:var(--font-size-body)] leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }
