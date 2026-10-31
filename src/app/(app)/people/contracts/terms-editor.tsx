"use client";
import { softGo } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { createContract, updateContractTerms, type HiringOptions } from "@/server/people";
import { PositionFields, CompensationFields } from "../person-forms";
import { termsInput, type TermsState } from "@/lib/people-forms";

/** A contract's terms: a new one for someone, or a draft being changed. */
export function TermsEditor({ mode, staffId, contractId, previousContractId, initial, options, selfUserId }: {
  mode: "create" | "edit";
  staffId: string;
  contractId?: string;
  previousContractId?: string | null;
  initial: TermsState;
  options: HiringOptions;
  selfUserId?: string | null;
}) {
  const [terms, setTerms] = useState<TermsState>(() => ({ ...initial, replacesContractId: previousContractId ?? undefined, editingContractId: contractId }));
  const [rebuild, setRebuild] = useState(true);
  const [errors, setErrors] = useState<Record<string, string[] | undefined>>();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    setError(null);
    start(async () => {
      const input = termsInput(terms) as never;
      const result = mode === "create"
        ? await createContract(staffId, input, previousContractId)
        : await updateContractTerms(contractId!, input, rebuild);
      if (!result.ok) { setError(result.error); setErrors(result.fieldErrors); return; }
      softGo(`/people/contracts/${result.data.id}`);
    });
  }

  return (
    <div className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}
      <Card>
        <CardHeader><CardTitle>Position and term</CardTitle></CardHeader>
        <CardContent><PositionFields value={terms} onChange={setTerms} options={options} errors={errors} selfUserId={selfUserId} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{terms.contractType === "COFOUNDER" ? "Financials" : "Compensation"}</CardTitle></CardHeader>
        <CardContent><CompensationFields value={terms} onChange={setTerms} options={options} errors={errors} /></CardContent>
      </Card>
      {mode === "edit" && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={rebuild} onChange={(e) => setRebuild(e.target.checked)} />
          <span>Rebuild the contract text from the template with these terms. Untick to keep wording you changed by hand; the new terms then show only in the summary.</span>
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => history.back()}>Cancel</Button>
        <Button type="button" disabled={pending} onClick={save}>
          {pending ? "Saving…" : mode === "create" ? "Prepare contract" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
