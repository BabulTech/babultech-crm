import * as React from "react";
import { PageStar } from "@/components/favorites-menu";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";
import { Inbox, Info, AlertTriangle, AlertCircle, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { FieldHelp } from "@/components/field-help";
import { BackLink } from "@/components/back-link";
import { priorityClass, type ColumnPriority } from "@/components/responsive-table";

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      // A press state on top of hover: the button moves under the cursor, which
      // is what makes a click feel like it landed.
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:shadow active:scale-[0.98]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 active:scale-[0.98]",
        outline:
          "border border-input bg-card shadow-sm hover:border-primary/30 hover:bg-accent active:scale-[0.98]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 active:scale-[0.98]",
        ghost: "hover:bg-accent hover:text-accent-foreground active:scale-[0.98]",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-card text-card-foreground shadow-sm",
        "shadow-slate-900/[0.04] dark:shadow-black/20",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col space-y-1 p-5 pb-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-base font-semibold leading-none tracking-tight", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5 pt-0", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center p-5 pt-0", className)} {...props} />;
}

// ---------------------------------------------------------------------------
// Badge — semantic colour per status family
// ---------------------------------------------------------------------------

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors whitespace-nowrap",
  {
    variants: {
      // A 1px ring in the same hue gives each badge a defined edge, which
      // matters on the muted row backgrounds where a flat fill goes soft.
      tone: {
        neutral: "border-transparent bg-secondary text-secondary-foreground ring-1 ring-inset ring-foreground/[0.06]",
        info: "border-transparent bg-blue-100 text-blue-800 ring-1 ring-inset ring-blue-600/20 dark:bg-blue-950 dark:text-blue-300 dark:ring-blue-400/20",
        success: "border-transparent bg-emerald-100 text-emerald-800 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-400/20",
        warning: "border-transparent bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-400/20",
        danger: "border-transparent bg-red-100 text-red-800 ring-1 ring-inset ring-red-600/20 dark:bg-red-950 dark:text-red-300 dark:ring-red-400/20",
        outline: "text-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/** Maps any status enum value in the app to a badge tone. */
export function statusTone(status: string): VariantProps<typeof badgeVariants>["tone"] {
  const s = status.toUpperCase();
  if (["CLOSED_WON", "PAID", "ACTIVE", "COMPLETED", "APPROVED", "ACCEPTED", "GREEN", "RESOLVED", "CLEARED", "PUBLISHED", "CONVERTED", "PAYABLE"].includes(s)) {
    return "success";
  }
  if (["CLOSED_LOST", "REJECTED", "CANCELLED", "OVERDUE", "RED", "CRITICAL", "TERMINATED", "FAILED", "DISQUALIFIED", "CLAWED_BACK", "WRITTEN_OFF", "BLOCKED"].includes(s)) {
    return "danger";
  }
  if (["AT_RISK", "AMBER", "ON_HOLD", "PENDING", "PENDING_APPROVAL", "PARTIALLY_PAID", "HIGH", "DELAYED", "WAITING_FOR_CUSTOMER", "NURTURING", "REVIEW", "UNDER_REVIEW"].includes(s)) {
    return "warning";
  }
  if (["NEGOTIATION", "VERBAL_CONFIRMATION", "QUOTE_SUBMITTED", "SENT", "IN_PROGRESS", "ACCRUED", "QUALIFIED", "ASSIGNED", "PLANNING"].includes(s)) {
    return "info";
  }
  return "neutral";
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm transition-all placeholder:text-muted-foreground hover:border-primary/30 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:bg-muted/50 disabled:opacity-60",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-[80px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm transition-all placeholder:text-muted-foreground hover:border-primary/30 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "flex h-9 w-full cursor-pointer rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm transition-all hover:border-primary/30 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = "Select";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-sm font-medium leading-none text-foreground", className)} {...props} />;
}

export function Field({
  label,
  hint,
  help,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  /**
   * Longer explanation, shown on hover/focus behind a marker beside the label.
   *
   * Use `hint` for something short that should always be visible, and `help`
   * for the sentence that answers "what am I supposed to put here?" — keeping
   * it out of the way stops every form reading like a manual.
   */
  help?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="inline-flex items-center">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
        {help && <FieldHelp text={help} />}
      </Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="table-scroll w-full">
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  // Sticky so the column names stay readable once a long list scrolls past
  // them — the header is the only thing telling you what a column means.
  return (
    <thead
      className={cn("sticky top-0 z-10 border-b bg-muted/60 backdrop-blur-sm", className)}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "border-b transition-colors last:border-0 hover:bg-muted/50",
        className,
      )}
      {...props}
    />
  );
}

export function TH({
  className,
  priority,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { priority?: ColumnPriority }) {
  return (
    <th
      className={cn(
        "h-10 whitespace-nowrap px-3 text-left align-middle text-[11px] font-semibold uppercase tracking-wider text-muted-foreground",
        priorityClass(priority),
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  priority,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { priority?: ColumnPriority }) {
  return (
    <td className={cn("px-3 py-3 align-middle", priorityClass(priority), className)} {...props} />
  );
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  backTo,
  backLabel,
  children,
}: {
  title: string;
  description?: string;
  /** Where the way out leads. Omit on a top-level list, which has no parent. */
  backTo?: string;
  backLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6 border-b pb-5">
      {backTo && <BackLink href={backTo} label={backLabel ?? "Back"} />}
      <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">{title} <PageStar title={title} /></h1>
        {description && (
          <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      </div>
    </div>
  );
}

export function StatTile({
  label,
  value,
  sublabel,
  help,
  tone = "neutral",
  href,
  icon,
}: {
  label: string;
  value: string;
  sublabel?: string;
  /** What the figure means, on the same terms as DetailRow's. */
  help?: string;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
  href?: string;
  /** Decorative only — the label already says what the tile is. */
  icon?: React.ReactNode;
}) {
  const toneClass = {
    neutral: "text-foreground",
    success: "text-emerald-600 dark:text-emerald-400",
    warning: "text-amber-600 dark:text-amber-400",
    danger: "text-red-600 dark:text-red-400",
    info: "text-blue-600 dark:text-blue-400",
  }[tone];

  // A thin bar down the left edge carries the tone, so a warning reads as one
  // at a glance without colouring the whole tile and shouting.
  const accentClass = {
    neutral: "bg-border",
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    danger: "bg-red-500",
    info: "bg-blue-500",
  }[tone];

  const body = (
    <Card
      className={cn(
        "relative h-full overflow-hidden p-4 pl-5",
        href && "lift cursor-pointer hover:border-primary/30",
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-1", accentClass)} aria-hidden />
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon && <span aria-hidden className={toneClass}>{icon}</span>}
        <p className="text-xs font-medium uppercase tracking-wide">{label}</p>
        {/* Only on a tile that is not itself a link: a <button> inside an <a>
            is invalid HTML, and the click would fight the navigation. A linked
            tile leads to the screen that explains itself anyway. */}
        {help && !href && <FieldHelp text={help} />}
      </div>
      <p className={cn("mt-1.5 text-2xl font-semibold tabular tracking-tight", toneClass)}>
        {value}
      </p>
      {sublabel && <p className="mt-0.5 text-xs text-muted-foreground">{sublabel}</p>}
    </Card>
  );

  return href ? (
    <Link href={href} className="block rounded-xl">
      {body}
    </Link>
  ) : (
    body
  );
}

/**
 * Rendered in place of a page the signed-in user may not see.
 *
 * Authorization is still enforced by `requirePermission` in the server layer —
 * this only decides what the refusal *looks like*. Pages check first and return
 * this so the user gets a sentence instead of a 500, because a thrown error
 * during the initial server render never reaches the error boundary.
 */
export function Forbidden({ what = "this screen" }: { what?: string }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center justify-center py-20 text-center">
      <Card className="w-full">
        <CardContent className="flex flex-col items-center gap-4 p-8">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-muted text-xl">🔒</span>
          <div>
            <h1 className="text-lg font-semibold">You do not have access to {what}</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Your role does not include it. If it should, ask an administrator to change your role.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href="/">Back to the dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/** Label-above-value row used down the side of every detail page. */
export function DetailRow({
  label,
  help,
  children,
}: {
  label: string;
  /**
   * What this field means, for the reader who did not fill it in.
   *
   * The create forms explain every field; the detail page explained none of
   * them, which is backwards — the person filling a form usually knows what
   * they are typing, while the person reading the record later is the one who
   * has to work out what "WhatsApp" is for when there is already a phone number.
   */
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        {help && <FieldHelp text={help} />}
      </p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-muted/20 px-6 py-16 text-center">
      <span
        className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-muted text-muted-foreground"
        aria-hidden
      >
        <Inbox className="h-5 w-5" />
      </span>
      <p className="font-medium">{title}</p>
      {description && (
        <p className="mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Alert({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  children: React.ReactNode;
}) {
  const toneClass = {
    info: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-200",
    warning: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200",
    danger: "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200",
  }[tone];

  const Icon = {
    info: Info,
    warning: AlertTriangle,
    danger: AlertCircle,
    success: CheckCircle2,
  }[tone];

  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("flex gap-3 rounded-lg border px-4 py-3 text-sm leading-relaxed", toneClass)}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
