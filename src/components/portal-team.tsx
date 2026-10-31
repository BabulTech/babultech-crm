"use client";
import { softReload } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { setPortalMember, invitePortalColleague, type TeamMember } from "@/server/portal-team";

/**
 * The logins at your company, for the portal Admin: who is an Admin, who is
 * switched off, and inviting a colleague. Others see the list only.
 */
export function PortalTeam({ team, isAdmin, adminMeans }: { team: TeamMember[]; isAdmin: boolean; adminMeans: string }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [invite, setInvite] = useState({ firstName: "", lastName: "", email: "", role: "USER" as "ADMIN" | "USER" });

  // A full reload after each change: see components/log-touch-button.tsx.
  const change = (m: TeamMember, role: "ADMIN" | "USER", active: boolean) =>
    start(async () => {
      setMessage(null);
      const result = await setPortalMember(m.id, role, active);
      if (!result.ok) return setMessage({ tone: "danger", text: result.error });
      softReload();
    });

  const send = () =>
    start(async () => {
      setMessage(null);
      const result = await invitePortalColleague(invite);
      if (!result.ok) return setMessage({ tone: "danger", text: result.error });
      setMessage({
        tone: "success",
        text: result.data.emailed
          ? `Invited. ${invite.firstName} has been emailed how to sign in.`
          : `The login is ready, but the email could not be sent. Ask us to resend ${invite.firstName}'s sign-in details.`,
      });
      setInvite({ firstName: "", lastName: "", email: "", role: "USER" });
      window.setTimeout(() => softReload(), 1500);
    });

  return (
    <div className="space-y-6">
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      <Card>
        <CardHeader>
          <CardTitle>Your company&apos;s logins</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{adminMeans}</p>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <THead>
              <TR>
                <TH>Person</TH>
                <TH>Role</TH>
                <TH>State</TH>
                {isAdmin && <TH />}
              </TR>
            </THead>
            <TBody>
              {team.map((m) => (
                <TR key={m.id}>
                  <TD className="text-sm">
                    <span className="font-medium">{m.fullName}</span>{m.isMe ? " (you)" : ""}
                    <p className="text-xs text-muted-foreground">{m.email}</p>
                  </TD>
                  <TD><Badge tone={m.portalRole === "ADMIN" ? "info" : "neutral"}>{m.portalRole === "ADMIN" ? "Admin" : "User"}</Badge></TD>
                  <TD><Badge tone={m.status === "ACTIVE" ? "success" : "warning"}>{m.status === "ACTIVE" ? "Can sign in" : "Switched off"}</Badge></TD>
                  {isAdmin && (
                    <TD className="text-right">
                      <span className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => change(m, m.portalRole === "ADMIN" ? "USER" : "ADMIN", m.status === "ACTIVE")}
                        >
                          {m.portalRole === "ADMIN" ? "Make User" : "Make Admin"}
                        </Button>
                        {!m.isMe && (
                          <Button size="sm" variant="ghost" disabled={pending} onClick={() => change(m, m.portalRole, m.status !== "ACTIVE")}>
                            {m.status === "ACTIVE" ? "Switch off" : "Switch on"}
                          </Button>
                        )}
                      </span>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Invite a colleague</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">They are emailed a password to sign in with, and asked to change it.</p>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
            <Field label="First name"><Input value={invite.firstName} onChange={(e) => setInvite({ ...invite, firstName: e.target.value })} maxLength={100} /></Field>
            <Field label="Last name"><Input value={invite.lastName} onChange={(e) => setInvite({ ...invite, lastName: e.target.value })} maxLength={100} /></Field>
            <Field label="Email"><Input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} maxLength={255} /></Field>
            <Field label="Role">
              <Select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value as "ADMIN" | "USER" })}>
                <option value="USER">User</option>
                <option value="ADMIN">Admin</option>
              </Select>
            </Field>
            <Button onClick={send} disabled={pending || !invite.firstName || !invite.lastName || !invite.email}>
              {pending ? "Inviting…" : "Invite"}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
