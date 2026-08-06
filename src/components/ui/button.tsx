import { cn } from "@/lib/utils";
import Link from "next/link";
import type { ComponentProps } from "react";

const VARIANT_CLASSES = {
  primary: "bg-accent text-white hover:opacity-90",
  secondary:
    "bg-transparent text-foreground border border-border hover:bg-foreground/5",
  ghost: "bg-transparent text-foreground hover:bg-foreground/5",
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
