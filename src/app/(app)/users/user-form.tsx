"use client";

import { PasswordInput } from "@/components/password-input";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Building2, ShieldCheck } from "lucide-react";
import { createUser, updateUser } from "@/server/users";
import {
  Button, Card, CardContent, CardHeader, CardTitle, Field, Input,
  Select, Alert, Badge,
} from "@/components/ui";
import { PicklistOptions } from "@/components/picklist";
import { SelectWithAdd } from "@/components/select-with-add";
import { createDepartment } from "@/server/reference-options";
import { cn, humanize } from "@/lib/utils";

const STATUSES = ["ACTIVE", "INACTIVE", "SUSPENDED"];

export interface UserFormOptions {
  roles: {
    id: string;
    name: string;
    description: string | null;
    dataScope: string;
    permissions: string[];
  }[];
  departments: { id: string; name: string }[];
  managers: { id: string; fullName: string; jobTitle: string | null }[];
  partners: { id: string; partnerNumber: string; displayName: string; kind: string }[];
}

export interface UserDefaults {
  id: string;
  fullName: string;
  email: string;
  notificationEmail: string | null;
  employeeNumber: string | null;
  jobTitle: string | null;
  phone: string | null;
  roleId: string;
  departmentId: string | null;
  managerUserId: string | null;
  partnerId: string | null;
  status: string;
  costRate: string | null;
  defaultBillingRate: string | null;
}

const SCOPE_EXPLAINER: Record<string, string> = {
  OWN: "Only records they own",
  TEAM: "Their team's records",
  DEPARTMENT: "Their own records and reporting subtree",
  ALL: "Every record in the system",
};

export function UserForm({
  options,
  defaults,
}: {
  options: UserFormOptions;
  defaults?: UserDefaults;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [roleId, setRoleId] = useState(defaults?.roleId ?? "");

  const editing = Boolean(defaults);
  const role = useMemo(() => options.roles.find((r) => r.id === roleId), [options.roles, roleId]);
  // Kept as a constant rather than deleted: an existing partner login can
  // still be opened here, and its employee-only fields must stay hidden.
  const isPartner = Boolean(defaults?.partnerId);

  // A submit HANDLER rather than <form action={...}>. React resets a form after
  // an action completes, and every field here is uncontrolled (defaultValue), so
  // with `action` a rejected submit cleared everything the user had typed and
  // made them fill the whole form in again to correct one field.
  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    setError(null);
    setFieldErrors({});

    const get = (k: string) => {
      const v = formData.get(k);
      return v === null || v === "" ? null : String(v);
    };

    const base = {
      fullName: String(formData.get("fullName") ?? ""),
      email: String(formData.get("email") ?? ""),
      notificationEmail: get("notificationEmail"),
      employeeNumber: isPartner ? null : get("employeeNumber"),
      jobTitle: get("jobTitle"),
      phone: get("phone"),
      roleId,
      departmentId: isPartner ? null : get("departmentId"),
      managerUserId: isPartner ? null : get("managerUserId"),
      partnerId: defaults?.partnerId ?? null,
      status: get("status") ?? "ACTIVE",
      costRate: isPartner ? null : get("costRate"),
      defaultBillingRate: isPartner ? null : get("defaultBillingRate"),
    };

    startTransition(async () => {
      const result = defaults
        ? await updateUser(defaults.id, base as never)
        : await createUser({ ...base, password: get("password") } as never);

      if (result.ok) {
        router.push(defaults ? "/users" : `/users/${result.data.id}${isPartner ? "" : "/teams"}`);
        router.refresh();
      } else {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>Select role</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            The role decides what they may do and how much they see. Roles are configured in Settings. Ownership, team membership and project assignments narrow it further.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {options.roles.map((r) => {
              const selected = r.id === roleId;
              const Icon = r.permissions.includes("*") || r.permissions.includes("all:except-delete") ? ShieldCheck : Building2;
              return (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setRoleId(r.id)}
                  className={cn(
                    "flex gap-3 rounded-lg border p-3 text-left transition-colors",
                    selected ? "border-primary bg-primary/5" : "hover:bg-accent",
                  )}
                >
                  <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{r.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {SCOPE_EXPLAINER[r.dataScope] ?? r.dataScope}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>

          {role && (
            <Alert tone={isPartner ? "warning" : "info"}>
              <p className="font-medium">{role.name}</p>
              {role.description && <p className="mt-0.5">{role.description}</p>}
              <p className="mt-1 text-xs">
                Sees: {SCOPE_EXPLAINER[role.dataScope] ?? role.dataScope} ·{" "}
                {role.permissions.includes("*")
                  ? "every permission"
                  : role.permissions.includes("all:except-delete")
                    ? "everything except deleting records and managing roles"
                    : `${role.permissions.length} permission(s)`}
              </p>
            </Alert>
          )}

          {isPartner && (
            <Alert tone="warning">
              This is an external partner login. Its partnership, password and access are managed on
              the partner&apos;s own page.
            </Alert>
          )}

          <Field label="Status" required
            help="Active people can sign in. Set to Inactive to cut off access without deleting their history.">
            <Select name="status" required defaultValue={defaults?.status ?? "ACTIVE"} className="sm:w-56">
              <PicklistOptions list="user_status" fallback={STATUSES} within={STATUSES} current={defaults?.status ?? "ACTIVE"} />
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Credentials</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" required error={fieldErrors.email?.[0]} hint="This is what they sign in with."
            help="Their work email. This is also the address they sign in with, so it has to be one they can reach.">
            <Input name="email" type="email" required defaultValue={defaults?.email} />
          </Field>

          <Field
            label="Send notifications to"
            error={fieldErrors.notificationEmail?.[0]}
            hint="Leave empty to use the sign-in address."
            help="Only needed when notifications must go somewhere other than the sign-in address - for example while the mailbox behind it does not exist yet. Sign-in is unaffected either way."
          >
            <Input
              name="notificationEmail"
              type="email"
              defaultValue={defaults?.notificationEmail ?? ""}
              placeholder={defaults?.email ?? "same as sign-in address"}
            />
          </Field>

          {editing ? (
            <div className="flex items-end">
              <p className="pb-2 text-sm text-muted-foreground">
                Passwords are set from the user's page, not here.
              </p>
            </div>
          ) : (
            <Field
              label="Password"
              required
              error={fieldErrors.password?.[0]}
              hint="At least 10 characters, mixed case, with a number."
            help="A temporary password. They are also emailed a link to choose their own."
            >
              <PasswordInput name="password" required autoComplete="new-password" />
            </Field>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Full name" required error={fieldErrors.fullName?.[0]}
            help="The person's name as it should appear across the system.">
            <Input name="fullName" required defaultValue={defaults?.fullName} />
          </Field>
          <Field label="Job title"
            help="Their role in words. Separate from their security role below, which is what governs access.">
            <Input name="jobTitle" defaultValue={defaults?.jobTitle ?? ""} placeholder="Senior Consultant" />
          </Field>
          <Field label="Phone"
            help="A contact number for them.">
            <Input name="phone" defaultValue={defaults?.phone ?? ""} placeholder="+92 300 1234567" />
          </Field>

          {!isPartner && (
            <>
              <Field label="Employee number"
            help="Your internal staff reference, if you use one.">
                <Input name="employeeNumber" defaultValue={defaults?.employeeNumber ?? ""} />
              </Field>
              <Field label="Department" error={fieldErrors.departmentId?.[0]}
            help="Which part of the business they belong to.">
                <SelectWithAdd
                  name="departmentId"
                  options={options.departments}
                  defaultValue={defaults?.departmentId ?? ""}
                  placeholder="None"
                  addLabel="Add a department"
                  onCreate={createDepartment}
                />
              </Field>
              <Field label="Reports to" error={fieldErrors.managerUserId?.[0]}
            help="Their manager. This is not decoration - it decides what a manager can see. Anyone on Department scope sees their own records plus everyone beneath them in this line.">
                <Select name="managerUserId" defaultValue={defaults?.managerUserId ?? ""}>
                  <option value="">Nobody</option>
                  {options.managers
                    .filter((m) => m.id !== defaults?.id)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.fullName}{m.jobTitle ? `, ${m.jobTitle}` : ""}
                      </option>
                    ))}
                </Select>
              </Field>
            </>
          )}
        </CardContent>
      </Card>

      {!isPartner && (
        <Card>
          <CardHeader>
            <CardTitle>Rates</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Used as the default when this person is booked onto a project. Without them their time
              has no default cost or billing value. Utilisation is calculated from hours, independently of rates.
            </p>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Cost rate per hour" hint="What they cost the business."
            help="What this person costs the business per hour. Used to work out project margin, and not shown to them.">
              <Input name="costRate" type="number" step="0.01" min="0" defaultValue={defaults?.costRate ?? ""} />
            </Field>
            <Field label="Billing rate per hour" hint="What a customer is charged."
            help="What a customer is charged per hour of their time, on hourly projects.">
              <Input
                name="defaultBillingRate"
                type="number"
                step="0.01"
                min="0"
                defaultValue={defaults?.defaultBillingRate ?? ""}
              />
            </Field>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between gap-2">
        {role && (
          <Badge tone={isPartner ? "warning" : "info"}>
            {isPartner ? "External login" : "Internal user"}
          </Badge>
        )}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="outline" onClick={() => router.back()} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !roleId}>
            {pending ? "Saving…" : editing ? "Save user" : "Create user"}
          </Button>
        </div>
      </div>
    </form>
  );
}
