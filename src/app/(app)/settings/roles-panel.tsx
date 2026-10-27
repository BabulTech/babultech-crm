"use client";

import { useMemo, useState, useTransition } from "react";
import { ALL_BUT_DELETE, SUPER_ADMIN_ONLY } from "@/lib/nav-permissions";
import { useRouter } from "next/navigation";
import { Lock, Plus, ShieldAlert, Trash2, Users } from "lucide-react";
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Field, Input, Select, Textarea,
} from "@/components/ui";
import {
  DATA_SCOPES, PERMISSION_CATALOGUE, effectivePermissions,
} from "@/lib/permission-catalogue";
import { saveRole, deleteRole, type RoleRow } from "@/server/roles";

/**
 * Roles, and what each one may do.
 *
 * The permission list is the catalogue, grouped the way the business is, with
 * each line saying what it actually lets someone do. A permission already
 * covered by a coarser one ticked above it is shown as included rather than
 * offered twice, because unticking it would change nothing.
 */
/**
 * Only the Super Admin (role:manage) creates or changes roles; everyone else
 * with Settings sees them read-only.
 */
export function RolesPanel({ roles, canManage = false }: { roles: RoleRow[]; canManage?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<RoleRow | "new" | null>(null);

  const role = editing === "new" ? null : editing;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<string>("OWN");
  const [granted, setGranted] = useState<Set<string>>(new Set());

  function open(target: RoleRow | "new") {
    setError(null);
    setNotice(null);
    setEditing(target);
    const source = target === "new" ? null : target;
    setName(source?.name ?? "");
    setDescription(source?.description ?? "");
    setScope(source?.dataScope ?? "OWN");
    setGranted(new Set(source?.permissions ?? []));
  }

  const covered = useMemo(() => effectivePermissions([...granted]), [granted]);
  // The two roles that hold a wide grant instead of individual ticks.
  const special: "all" | "crm" | null = role?.permissions.includes("*") ? "all" : role?.permissions.includes(ALL_BUT_DELETE) ? "crm" : null;

  // For someone doing two jobs: one role with both roles' permissions. It sees
  // as narrowly as the narrower of the two until someone chooses otherwise,
  // so combining never quietly widens what a person can read.
  const [combineA, setCombineA] = useState("");
  const [combineB, setCombineB] = useState("");
  const SCOPE_ORDER = ["OWN", "TEAM", "DEPARTMENT", "ALL"];
  function combine() {
    const a = roles.find((r) => r.id === combineA);
    const b = roles.find((r) => r.id === combineB);
    if (!a || !b || a.id === b.id) return;
    setError(null);
    setNotice(null);
    setEditing("new");
    setName(`${a.name} + ${b.name}`);
    setDescription(`Does both jobs: ${a.name} and ${b.name}.`);
    setScope(SCOPE_ORDER[Math.min(SCOPE_ORDER.indexOf(a.dataScope), SCOPE_ORDER.indexOf(b.dataScope))] ?? "OWN");
    setGranted(new Set([...a.permissions, ...b.permissions].filter((p) => p !== "*")));
  }

  function toggle(value: string) {
    setGranted((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    start(async () => {
      const result = await saveRole({
        id: role?.id ?? null,
        name,
        description,
        dataScope: scope,
        permissions: [...granted],
      });
      if (result.ok) {
        setEditing(null);
        setNotice(role ? `${name} updated. Everyone holding it is affected straight away.` : `${name} created.`);
        router.refresh();
      } else setError(result.error);
    });
  }

  function onDelete(target: RoleRow) {
    if (!window.confirm(`Delete the ${target.name} role?`)) return;
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await deleteRole(target.id);
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>Roles and permissions</CardTitle>
          <CardDescription>
            What each kind of person may do, and how much they may see. A change takes effect on
            everyone holding the role immediately.
          </CardDescription>
        </div>
        {canManage && <Button variant="secondary" onClick={() => open("new")}>
          <Plus className="h-4 w-4" /> Add role
        </Button>}
      </CardHeader>

      <CardContent className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}

        {editing === null && canManage && (
          <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-3" data-combine-roles>
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">Someone doing two jobs?</p>
              <p className="text-xs text-muted-foreground">Combine two roles into a new one with both sets of permissions. Each person still holds one role.</p>
            </div>
            <Select aria-label="First role" className="w-44" value={combineA} onChange={(e) => setCombineA(e.target.value)}>
              <option value="">First role</option>
              {roles.filter((r) => !r.permissions.includes("*") && !r.permissions.includes("all:except-delete")).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
            <Select aria-label="Second role" className="w-44" value={combineB} onChange={(e) => setCombineB(e.target.value)}>
              <option value="">Second role</option>
              {roles.filter((r) => !r.permissions.includes("*") && !r.permissions.includes("all:except-delete") && r.id !== combineA).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
            <Button type="button" variant="outline" disabled={!combineA || !combineB} onClick={combine}>Combine</Button>
          </div>
        )}

        {editing === null ? (
          <ul className="divide-y rounded-md border">
            {roles.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium">
                    {r.name}
                    {r.isSystem && (
                      <span title="Built in: the application depends on this role">
                        <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                      </span>
                    )}
                  </p>
                  {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge tone="neutral">
                      Sees: {DATA_SCOPES.find((s) => s.value === r.dataScope)?.label ?? r.dataScope}
                    </Badge>
                    <span>
                      {r.permissions.includes("*") ? "every permission" : r.permissions.includes("all:except-delete") ? "everything except deleting and roles" : `${r.permissions.length} permission(s)`}
                    </span>
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" /> {r.userCount}
                    </span>
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => open(r)}>
                    {r.isSystem || !canManage ? "View" : "Edit"}
                  </Button>
                  {!r.isSystem && canManage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => onDelete(r)}
                      className="text-destructive hover:text-destructive"
                      aria-label={`Delete ${r.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <form onSubmit={onSubmit} className="space-y-5">
            {role?.isSystem && (
              <Alert tone="info">
                <span className="font-medium">{role.name} is built in.</span> The application depends
                on what it can do, so it is shown here but cannot be changed. Create a new role to
                make a variation of it.
              </Alert>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Role name" required>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={role?.isSystem}
                  maxLength={100}
                  required
                  placeholder="Finance"
                />
              </Field>
              <Field label="How much they see" required help="Which records the role may open, before permissions are considered.">
                <Select value={scope} onChange={(e) => setScope(e.target.value)} disabled={role?.isSystem}>
                  {DATA_SCOPES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label} — {s.help}</option>
                  ))}
                </Select>
              </Field>
              <div className="sm:col-span-2">
                <Field label="Description" help="What this role is for, in a sentence. It is shown when picking a role for someone.">
                  <Textarea
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={role?.isSystem}
                  />
                </Field>
              </div>
            </div>

            {/* Every role shows the whole list. The Super Admin and CRM Admin hold
                theirs through one wide grant, so their ticks show what that grant
                covers and cannot be changed one by one. */}
            {special === "crm" && (
              <Alert tone="info">This role holds every permission except deleting records and managing roles, which only the Super Admin has. Permissions added to the system later are included automatically, so the ticks below cannot be changed one by one.</Alert>
            )}
            {special === "all" && (
              <Alert tone="warning">This role holds every permission in the system, including ones added later. The ticks below cannot be changed one by one.</Alert>
            )}
            {(
              <div className="space-y-4">
                {PERMISSION_CATALOGUE.map((group) => (
                  <fieldset key={group.name} className="rounded-lg border p-4">
                    <legend className="px-1 text-sm font-medium">{group.name}</legend>
                    <p className="mb-3 text-xs text-muted-foreground">{group.description}</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {group.permissions.map((permission) => {
                        const bySpecial = special === "all" || (special === "crm" && !SUPER_ADMIN_ONLY.includes(permission.value));
                        const ticked = bySpecial || granted.has(permission.value);
                        const impliedOnly = !ticked && covered.has(permission.value);
                        return (
                          <label
                            key={permission.value}
                            className={`flex gap-2 rounded-md border p-2 ${impliedOnly ? "opacity-70" : ""}`}
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 shrink-0 rounded border-input"
                              checked={ticked || impliedOnly}
                              disabled={role?.isSystem || impliedOnly || special !== null}
                              onChange={() => toggle(permission.value)}
                            />
                            <span className="min-w-0">
                              <span className="flex items-center gap-1.5 text-sm font-medium">
                                {permission.label}
                                {permission.sensitive && (
                                  <span title="Sensitive: money, credentials or the system itself">
                                    <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />
                                  </span>
                                )}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {special === "crm" && SUPER_ADMIN_ONLY.includes(permission.value)
                                  ? "Only the Super Admin has this."
                                  : impliedOnly ? "Already included by a wider permission above." : permission.help}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                {role?.isSystem ? "Close" : "Cancel"}
              </Button>
              {!role?.isSystem && (
                <Button type="submit" disabled={pending || !name.trim()}>
                  {pending ? "Saving…" : role ? "Save role" : "Create role"}
                </Button>
              )}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
