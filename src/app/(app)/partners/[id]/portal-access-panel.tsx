"use client";

import { PasswordInput } from "@/components/password-input";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, ShieldCheck } from "lucide-react";
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input,
} from "@/components/ui";
import { formatDateTime } from "@/lib/utils";
import {
  grantPartnerAccess, resetPartnerPassword, revokePartnerAccess,
  type PartnerLoginPerson,
} from "@/server/partner-access";

/**
 * Who at this partner can sign in to the partner portal.
 *
 * On the partner's own page rather than in the staff list: an external login is
 * not an employee, and whoever manages the partnership is the one who should
 * decide who may see its deals and commission.
 */
export function PartnerPortalPanel({
  partnerId,
  people,
  canManage,
}: {
  partnerId: string;
  people: PartnerLoginPerson[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** contactId being granted, or userId being reset. */
  const [form, setForm] = useState<{ mode: "grant" | "reset"; id: string } | null>(null);

  function announce(result: { emailed: boolean; email: string; emailError: string | null }, granted: boolean) {
    setForm(null);
    setNotice(
      result.emailed
        ? granted
          ? `${result.email} can now sign in. We have emailed them the password.`
          : `A new password has been emailed to ${result.email}.`
        : `${granted ? "Access is set up" : "The password was changed"}, but the email did not go out (${result.emailError ?? "unknown reason"}). Send it to them yourself.`,
    );
    router.refresh();
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>, person: PartnerLoginPerson) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    setError(null);
    setNotice(null);

    start(async () => {
      const result = person.login
        ? await resetPartnerPassword({ partnerId, userId: person.login.userId, password })
        : await grantPartnerAccess({ partnerId, contactId: person.contactId!, password });
      if (result.ok) announce(result.data, !person.login);
      else setError(result.error);
    });
  }

  function onRevoke(person: PartnerLoginPerson) {
    if (!person.login) return;
    if (!window.confirm(`Remove ${person.name}'s access to the partner portal?`)) return;
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await revokePartnerAccess(partnerId, person.login!.userId);
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> Portal access
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Who at this partner can sign in to register deals and see their commission.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && <Alert tone="danger">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}

        {people.length === 0 ? (
          <p className="text-muted-foreground">
            Nobody is recorded at this partner yet. Add their people as contacts of the partner&apos;s
            account, and they can be given access here.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {people.map((person) => {
              const key = person.login?.userId ?? person.contactId ?? person.name;
              const open = form && form.id === key;
              return (
                <li key={key} className="space-y-3 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {person.name}
                        {person.login && <Badge tone="success" className="ml-2">Can sign in</Badge>}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {person.email ?? "No email address"}
                        {person.role && ` · ${person.role}`}
                        {person.login &&
                          (person.login.lastLoginAt
                            ? ` · last signed in ${formatDateTime(person.login.lastLoginAt)}`
                            : " · has not signed in yet")}
                      </p>
                    </div>

                    {canManage && (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending || !person.email}
                          title={person.email ? undefined : "Add an email address to the contact first."}
                          onClick={() => { setForm({ mode: person.login ? "reset" : "grant", id: key }); setError(null); setNotice(null); }}
                        >
                          <KeyRound className="h-4 w-4" />
                          {person.login ? "Send a new password" : "Give access"}
                        </Button>
                        {person.login && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            onClick={() => onRevoke(person)}
                            className="text-destructive hover:text-destructive"
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                    )}
                  </div>

                  {open && (
                    <form onSubmit={(e) => onSubmit(e, person)} className="rounded-md border border-dashed p-3">
                      <Field
                        label={person.login ? "New password" : "Temporary password"}
                        required
                        help="At least 12 characters. We email it to them; it is not shown again here."
                      >
                        <PasswordInput name="password" minLength={12} required autoComplete="new-password" />
                      </Field>
                      <div className="mt-3 flex gap-2">
                        <Button type="submit" size="sm" disabled={pending}>
                          {pending ? "Sending…" : "Set and email it"}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setForm(null)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
