"use client";
import { softReload, softGo } from "@/components/soft-navigation";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { BoldButton } from "@/components/bold-button";
import { ContractText } from "@/components/contract-text";
import { DeleteConfirm } from "@/components/delete-confirm";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui";
import { SignaturePad } from "@/components/signature-pad";
import {
  sendForSigning, withdrawSigning, signForCompany, markSignedByHand, cancelContract, endContractEarly, updateContractText,
} from "@/server/people";
import { CANCELLABLE_STATUSES, contractDate, karachiToday, type ContractStatus } from "@/lib/people";
import { formatDateTime } from "@/lib/utils";

interface ContractSummary {
  id: string;
  status: ContractStatus;
  contractNumber: string;
  startDate: string;
  endDate: string | null;
  contractType: string;
  /** Who is signed in, to fill the company signature form. */
  signerName: string;
  signerTitle: string | null;
  personalEmail: string | null;
  staffId: string;
  signTokenExpiresAt: string | null;
  hasSuccessor: boolean;
}

type Result = { ok: true; data?: unknown } | { ok: false; error: string };

/** What can be done with the contract next, by where it is in its life. */
export function ContractActions({ contract: c }: { contract: ContractSummary }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; emailedTo: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [panel, setPanel] = useState<"cancel" | "end" | "paper" | null>(null);

  const run = (action: () => Promise<Result>, after?: (r: Result) => void) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) { setError(result.error); return; }
      if (after) after(result);
      else softReload();
    });

  const issue = (email: boolean) =>
    run(() => sendForSigning(c.id, { email }), (r) => {
      setLink((r as { data: { url: string; emailedTo: string | null } }).data);
      setCopied(false);
    });

  const today = karachiToday();

  return (
    <Card>
      <CardHeader><CardTitle>Next step</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        {error && <Alert tone="danger">{error}</Alert>}

        {link && (
          <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
            <p className="font-medium">{link.emailedTo ? `Emailed to ${link.emailedTo}.` : "Signing link ready."} It works for 14 days and is shown only now.</p>
            <Input readOnly value={link.url} name="signingLink" onFocus={(e) => e.currentTarget.select()} />
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={async () => { await navigator.clipboard.writeText(link.url).catch(() => {}); setCopied(true); }}>{copied ? "Copied" : "Copy link"}</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => softReload()}>Done</Button>
            </div>
          </div>
        )}

        {(c.status === "DRAFT" || c.status === "SENT") && !link && (
          <div className="space-y-2">
            <p className="font-medium">{c.status === "DRAFT" ? "Send it for digital signing" : "Waiting for them to sign"}</p>
            {c.status === "SENT" && c.signTokenExpiresAt && <p className="text-muted-foreground">The link works until {formatDateTime(`${c.signTokenExpiresAt}Z`)}. A new link replaces the old one.</p>}
            <p className="text-muted-foreground">They open the link, read the contract, type their name and draw their signature. Then you sign for the company here.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={pending} onClick={() => issue(false)}>{c.status === "DRAFT" ? "Get signing link" : "New link"}</Button>
              {c.personalEmail && <Button type="button" variant="outline" disabled={pending} onClick={() => issue(true)}>Email it to {c.personalEmail}</Button>}
            </div>
            {c.status === "SENT" && <Button type="button" variant="link" className="h-auto p-0" disabled={pending} onClick={() => run(() => withdrawSigning(c.id))}>Withdraw it and go back to editing</Button>}
          </div>
        )}

        {c.status === "EMPLOYEE_SIGNED" && (
          <div className="space-y-3">
            <p className="font-medium">They have signed. Sign for the company.</p>
            <form className="space-y-3" onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const name = String(form.get("companySignerName") ?? "");
              const title = String(form.get("companySignerTitle") ?? "");
              run(() => signForCompany(c.id, { name, signature: signature ?? "", title }));
            }}>
              <Field label="Your full name" required><Input name="companySignerName" defaultValue={c.signerName} required /></Field>
              <Field label="Your designation" hint={'Shown with your signature, e.g. "Hasan Shamsi (CEO)". From your job title under Users.'}>
                <Input name="companySignerTitle" defaultValue={c.signerTitle ?? ""} placeholder="CEO" maxLength={150} />
              </Field>
              <SignaturePad onChange={setSignature} label="Company signature" />
              <Button type="submit" disabled={pending || !signature}>Sign for the company</Button>
            </form>
          </div>
        )}

        {["DRAFT", "SENT", "EMPLOYEE_SIGNED"].includes(c.status) && (
          <div className="border-t pt-3">
            {panel !== "paper" ? (
              <Button type="button" variant="link" className="h-auto p-0" onClick={() => setPanel("paper")}>Signed on paper instead?</Button>
            ) : (
              <form className="space-y-2" onSubmit={(e) => {
                e.preventDefault();
                const signedOn = String(new FormData(e.currentTarget).get("signedOn"));
                run(() => markSignedByHand(c.id, { signedOn }));
              }}>
                <p className="text-muted-foreground">Print it, have both sides sign, and upload the scan under Documents. Then record it here.</p>
                <Field label="Date it was signed" required><Input type="date" name="signedOn" max={today} defaultValue={today} required /></Field>
                <div className="flex gap-2">
                  <Button type="submit" disabled={pending}>Mark as signed</Button>
                  <Button type="button" variant="outline" onClick={() => setPanel(null)}>Cancel</Button>
                </div>
              </form>
            )}
          </div>
        )}

        {c.status === "SIGNED" && (
          <p>Signed. It starts on <span className="font-medium">{contractDate(c.startDate)}</span>, and their login switches on that day if it is off.</p>
        )}

        {c.status === "ACTIVE" && (
          <div className="space-y-3">
            {c.endDate ? (
              <p>Running until <span className="font-medium">{contractDate(c.endDate)}</span>. If nothing follows it, it ends then and their login is switched off the day after.</p>
            ) : (
              <p>Running, with no end date. To change equity, areas or financials, revise it: the new agreement replaces this one once signed.</p>
            )}
            {!c.hasSuccessor && c.contractType === "COFOUNDER" && (
              <Button asChild><Link href={`/people/${c.staffId}/contracts/new?from=${c.id}&mode=renew`}>Revise agreement</Link></Button>
            )}
            {!c.hasSuccessor && c.contractType !== "COFOUNDER" && (
              <div className="flex flex-wrap gap-2">
                <Button asChild><Link href={`/people/${c.staffId}/contracts/new?from=${c.id}&mode=renew`}>Renew</Link></Button>
                <Button asChild variant="outline"><Link href={`/people/${c.staffId}/contracts/new?from=${c.id}&mode=convert`}>Convert to employment</Link></Button>
              </div>
            )}
            {panel !== "end" ? (
              <Button type="button" variant="link" className="h-auto p-0" onClick={() => setPanel("end")}>Terminate, or record a resignation</Button>
            ) : (
              <form className="space-y-3 rounded-md border p-3" onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(() => endContractEarly(c.id, {
                  kind: String(f.get("endKind")) as "TERMINATED" | "RESIGNED",
                  lastWorkingDay: String(f.get("lastWorkingDay")),
                  noticeGivenOn: String(f.get("noticeGivenOn") || "") || null,
                  reason: String(f.get("endReason")),
                }));
              }}>
                <Field label="What happened" required>
                  <Select name="endKind" defaultValue="RESIGNED">
                    <option value="RESIGNED">They resigned</option>
                    <option value="TERMINATED">The company is terminating it</option>
                  </Select>
                </Field>
                <Field label="Notice given on"><Input type="date" name="noticeGivenOn" defaultValue={today} /></Field>
                <Field label="Last working day" required hint="Their login stays on until then."><Input type="date" name="lastWorkingDay" min={c.startDate} max={c.endDate ?? undefined} required /></Field>
                <Field label="Reason" required><Textarea name="endReason" rows={2} required /></Field>
                <div className="flex gap-2">
                  <Button type="submit" variant="destructive" disabled={pending}>Record it</Button>
                  <Button type="button" variant="outline" onClick={() => setPanel(null)}>Cancel</Button>
                </div>
              </form>
            )}
          </div>
        )}

        {["ENDED", "RENEWED", "CONVERTED", "TERMINATED", "RESIGNED", "CANCELLED"].includes(c.status) && (
          <p className="text-muted-foreground">This contract is finished. Its history stays here.</p>
        )}

        {CANCELLABLE_STATUSES.includes(c.status) && (
          <div className="border-t pt-3">
            {panel !== "cancel" ? (
              <Button type="button" variant="link" className="h-auto p-0 text-destructive" onClick={() => setPanel("cancel")}>Cancel this contract</Button>
            ) : (
              <form className="space-y-2" onSubmit={(e) => {
                e.preventDefault();
                const reason = String(new FormData(e.currentTarget).get("cancelReason"));
                run(() => cancelContract(c.id, reason));
              }}>
                <Field label="Why is it cancelled?" required><Textarea name="cancelReason" rows={2} required /></Field>
                <div className="flex gap-2">
                  <Button type="submit" variant="destructive" disabled={pending}>Cancel contract</Button>
                  <Button type="button" variant="outline" onClick={() => setPanel(null)}>Keep it</Button>
                </div>
              </form>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The contract wording and its special notes, editable while a draft. Bold is
 * **double asterisks**; the preview shows the contract as it will be read.
 */
export function ContractTextEditor({ contractId, body, notes }: { contractId: string; body: string; notes: string | null }) {
  const [text, setText] = useState(body);
  const [special, setSpecial] = useState(notes ?? "");
  const [saved, setSaved] = useState({ text: body, special: notes ?? "" });
  const [preview, setPreview] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const changed = text !== saved.text || special !== saved.special;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <BoldButton target={() => (document.activeElement === notesRef.current ? notesRef.current : bodyRef.current)} />
        <Button type="button" variant="outline" size="sm" onClick={() => setPreview(!preview)}>{preview ? "Edit" : "Preview"}</Button>
        <span className="text-xs text-muted-foreground">Select words and press Bold. They show as **words** here and in bold on the contract.</span>
      </div>
      {preview ? (
        <ContractText body={text} notes={special} className="rounded-md border bg-muted/30 p-4 font-serif text-sm leading-relaxed" />
      ) : (
        <>
          <Textarea ref={bodyRef} name="contractBody" rows={24} className="font-serif text-sm leading-relaxed" value={text} onChange={(e) => { setText(e.target.value); setMessage(null); }} />
          <Field label="Special notes" hint="Optional. Printed in a highlighted section above the signatures, and part of what is signed. Bold works here too.">
            <Textarea ref={notesRef} name="specialNotes" rows={4} maxLength={4000} placeholder="e.g. **Probation of one month applies.**" value={special} onChange={(e) => { setSpecial(e.target.value); setMessage(null); }} />
          </Field>
        </>
      )}
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Change the wording and notes freely while it is a draft. Once sent, both are frozen.</p>
        <Button type="button" size="sm" disabled={pending || !changed} onClick={() => start(async () => {
          const r = await updateContractText(contractId, text, special);
          if (r.ok) setSaved({ text, special });
          setMessage(r.ok ? { tone: "success", text: "Saved." } : { tone: "danger", text: r.error });
        })}>Save wording</Button>
      </div>
    </div>
  );
}

/** Delete, for the Super Admin: the shared confirmation, then back to the person. */
export function ContractDeleteButton({ contractId, name, staffId }: { contractId: string; name: string; staffId: string; blocker?: string | null }) {
  return <DeleteConfirm type="EmploymentContract" id={contractId} name={name} variant="button" onDone={() => { softGo(`/people/${staffId}`); }} />;
}
