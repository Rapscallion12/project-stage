import { cn } from "@/lib/utils";
import Link from "next/link";
import type { ComponentProps } from "react";

// Visual identity pass: `hover:bg-accent-hover` (a deliberately distinct
// shade, not `hover:opacity-90`'s generic dimming) — a real hover color
// reads as an intentionally designed state, the same reasoning the new
// `--accent-hover` token exists for at all (see globals.css/DECISIONS.md).
const VARIANT_CLASSES = {
  primary: "bg-accent text-white hover:bg-accent-hover",
  secondary:
    "bg-transparent text-foreground border border-border hover:bg-surface-hover",
  ghost: "bg-transparent text-foreground hover:bg-surface-hover",
} as const;

// min-h-11 (44px) keeps every button a comfortable touch target on mobile,
// per the project's responsive design principle (see PRODUCT.md).
const BASE_CLASSES =
  "inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none";

type Variant = keyof typeof VARIANT_CLASSES;

type ButtonProps = ComponentProps<"button"> & { variant?: Variant };

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(BASE_CLASSES, VARIANT_CLASSES[variant], className)}
      {...props}
    />
  );
}

type ButtonLinkProps = ComponentProps<typeof Link> & { variant?: Variant };

/** Renders like <Button> but as a navigable link — use for navigation, not form submission. */
export function ButtonLink({
  variant = "primary",
  className,
  ...props
}: ButtonLinkProps) {
  return (
    <Link
      className={cn(BASE_CLASSES, VARIANT_CLASSES[variant], className)}
      {...props}
    />
  );
}
