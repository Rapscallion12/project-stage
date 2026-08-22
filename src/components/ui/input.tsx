import { cn } from "@/lib/utils";
import { forwardRef } from "react";
import type { ComponentProps } from "react";

export const Input = forwardRef<HTMLInputElement, ComponentProps<"input">>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        // text-base (16px), not text-sm: iOS Safari auto-zooms the
        // viewport on focus for inputs smaller than 16px.
        "w-full rounded-lg border border-border bg-transparent px-3.5 py-2.5 text-base outline-none transition-colors focus:border-accent",
        className,
      )}
      {...props}
    />
  );
});

export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      className={cn("mb-1.5 block text-sm font-medium", className)}
      {...props}
    />
  );
}
