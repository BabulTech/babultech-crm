"use client";
import { softReload } from "@/components/soft-navigation";
import { useState, useTransition } from "react";
import { changeUserTeam, createUserTeam, setRoleInTeam, type getUserTeams } from "@/server/user-teams";
import { Button, Card, CardContent, Input, Select, Alert } from "@/components/ui";
import { PicklistOptions, usePicklistLabel } from "@/components/picklist";

/**
 * Which teams someone is in, and their part in each. Someone can be in several:
 * a developer who also tests and handles tickets is in Development, QA and
 * Support. Team types come from Settings › Team type.
 */
export function TeamEditor({ userId, data }: { userId: string; data: Awaited<ReturnType<typeof getUserTeams>> }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const typeLabel = usePicklistLabel("team_type");
  const membership = new Map(data.memberships.map(m => [m.teamId, m]));
  const [parts, setParts] = useState<Record<string, string>>(() => Object.fromEntries(data.memberships.map(m => [m.teamId, m.roleInTeam ?? ""])));
  // A full reload after saving: see components/log-touch-button.tsx.
  function run(action: () => Promise<{ error: string | null }>) {
    start(async () => { try { const result = await action(); setError(result.error); if (!result.error) softReload(); } catch { setError("Could not save. Refresh and check your access."); } });
  }
  return <div className="mt-4 space-y-4">
    {error && <Alert tone="danger">{error}</Alert>}
    <Card><CardContent className="space-y-3 p-4">
      <h2 className="font-semibold">Team membership</h2>
      <p className="text-sm text-muted-foreground">Someone can be in as many teams as the work they do. Removing membership removes that team&rsquo;s access path; their role, ownership and assignments may still grant access.</p>
      {data.teams.length === 0 && <p>No teams yet. Create one below.</p>}
      {data.teams.map(team => {
        const member = membership.get(team.id);
        const blocked = !member && (!team.active || data.user.status !== "ACTIVE" || Boolean(data.user.partnerId));
        return <div key={team.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2" data-team-row={team.name}>
          <span className="min-w-40">{team.name} · <span className="text-muted-foreground">{typeLabel(team.teamType)}</span>{!team.active && " · Inactive"}</span>
          <span className="flex flex-1 flex-wrap items-center justify-end gap-2">
            <Input aria-label={`Part in ${team.name}`} name="roleInTeam" className="h-8 max-w-56" placeholder="Their part, e.g. Lead tester"
              value={parts[team.id] ?? ""} onChange={e => setParts({ ...parts, [team.id]: e.target.value })} />
            {member && (parts[team.id] ?? "") !== (member.roleInTeam ?? "") && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => setRoleInTeam({ userId, teamId: team.id, roleInTeam: parts[team.id] ?? "" }))}>Save part</Button>
            )}
            <Button size="sm" disabled={pending || blocked} variant="outline" onClick={() => run(() => changeUserTeam({ userId, teamId: team.id, operation: member ? "remove" : "add", roleInTeam: parts[team.id] || null }))}>{member ? "Remove" : "Add"}</Button>
          </span>
        </div>;
      })}
    </CardContent></Card>
    <Card><CardContent className="p-4"><h2 className="mb-3 font-semibold">Create team</h2>
      <form className="flex flex-wrap gap-3" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); run(() => createUserTeam({ name: String(values.get("name")), teamType: String(values.get("teamType")) })); }}>
        <Input name="name" aria-label="Team name" required minLength={2} maxLength={100} placeholder="QA" />
        <Select name="teamType" aria-label="Team type"><PicklistOptions list="team_type" fallback={["SALES", "SUPPORT", "PROJECT", "FINANCE", "MARKETING"]} /></Select>
        <Button disabled={pending}>Create team</Button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">More team types can be added under Settings › Team type.</p>
    </CardContent></Card>
  </div>;
}
