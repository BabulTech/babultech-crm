"use client";
import { softGo } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Select } from "@/components/ui";
import { updateProfile, setReportsTo, type getReportingLine } from "@/server/people";
import { PersonalFields, BackgroundFields } from "../../person-forms";
import { profileState, type ProfileState } from "@/lib/people-forms";

export function ProfileEditor({ staffId, initial, reportingLine }: {
  staffId: string;
  initial: Record<string, unknown>;
  reportingLine: Awaited<ReturnType<typeof getReportingLine>>;
}) {
  const [profile, setProfile] = useState<ProfileState>(() => profileState(initial));
  const startingManager = reportingLine?.current?.active ? reportingLine.current.id : "";
  const [reportsTo, setReportsToValue] = useState(startingManager);
  const [errors, setErrors] = useState<Record<string, string[] | undefined>>();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    setError(null);
    start(async () => {
      const result = await updateProfile(staffId, profile);
      if (!result.ok) { setError(result.error); setErrors(result.fieldErrors); return; }
      // A manager whose login is switched off is shown but never kept by accident:
      // saving with nobody chosen clears them.
      if (reportsTo !== startingManager || (reportingLine?.current && !reportingLine.current.active)) {
        const moved = await setReportsTo(staffId, reportsTo || null);
        if (!moved.ok) { setError(moved.error); return; }
      }
      softGo(`/people/${staffId}`);
    });
  }

  return (
    <div className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}
      <Card>
        <CardHeader><CardTitle>Reports to</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {reportingLine?.current && !reportingLine.current.active && (
            <Alert tone="warning">
              They report to {reportingLine.current.fullName} ({reportingLine.current.email}), whose login is switched off. Choose who they report to now.
            </Alert>
          )}
          <Field label="Manager" hint="Their manager on their login and current contracts. A Lead role sees the records of everyone who reports to them.">
            <Select name="reportsToUserId" value={reportsTo} onChange={(e) => setReportsToValue(e.target.value)} className="max-w-md">
              <option value="">Nobody</option>
              {(reportingLine?.options ?? []).map((u) => <option key={u.id} value={u.id}>{u.fullName}{u.jobTitle ? ` · ${u.jobTitle}` : ""}</option>)}
            </Select>
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Personal details</CardTitle></CardHeader>
        <CardContent><PersonalFields value={profile} onChange={setProfile} errors={errors} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Education, experience and skills</CardTitle></CardHeader>
        <CardContent><BackgroundFields value={profile} onChange={setProfile} errors={errors} /></CardContent>
      </Card>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => history.back()}>Cancel</Button>
        <Button type="button" disabled={pending} onClick={save}>{pending ? "Saving…" : "Save changes"}</Button>
      </div>
    </div>
  );
}
