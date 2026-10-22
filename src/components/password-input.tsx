"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Password field with a reveal toggle. Used for every password the app asks
 * for, so the toggle behaves the same everywhere.
 *
 * The button is type="button" so it never submits the form it sits in, and it
 * carries an explicit label — screen readers announce the action, and the
 * pressed state tells them which way it is currently set.
 */
export function PasswordInput({
  name = "password",
  autoComplete = "current-password",
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input
        {...props}
        name={name}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        className={cn("pr-9", className)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 grid w-9 place-items-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-r-md"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
