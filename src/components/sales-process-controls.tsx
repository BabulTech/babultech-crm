"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FilePlus2, Rocket } from "lucide-react";
import { Button, Alert, Select } from "@/components/ui";
import { setOpportunityOffering } from "@/server/offerings";
import { createProposal } from "@/server/proposals";
import { startOnboarding } from "@/server/onboarding";

export function OfferingPicker({ opportunityId, value, offerings, disabled }: { opportunityId: string; value: string | null; offerings: { id: string; name: string }[]; disabled: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <Select aria-label="Offering" data-offering-picker defaultValue={value ?? ""} disabled={disabled || pending} onChange={(e) => {
        const next = e.target.value || null;
        start(async () => {
          setError(null);
          const r = await setOpportunityOffering(opportunityId, next);
          if (!r.ok) setError(r.error); else router.refresh();
        });
      }}>
        <option value="">Not set</option>
        {offerings.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </Select>
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

export function CreateProposal({ opportunityId, templates, defaultTemplateId }: { opportunityId: string; templates: { id: string; name: string }[]; defaultTemplateId: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState(defaultTemplateId ?? "");
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Select aria-label="Proposal template" value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="min-w-[200px] flex-1">
          <option value="">Blank proposal</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
        <Button disabled={pending} onClick={() => start(async () => {
          setError(null);
          const r = await createProposal(opportunityId, templateId || null);
          if (!r.ok) setError(r.error); else router.push(`/proposals/${r.data.id}`);
        })}>
          <FilePlus2 className="h-4 w-4" /> {pending ? "Creating…" : "Create proposal"}
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

export function StartOnboarding({ opportunityId, playbooks, defaultPlaybookId }: { opportunityId: string; playbooks: { id: string; name: string }[]; defaultPlaybookId: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [playbookId, setPlaybookId] = useState(defaultPlaybookId ?? playbooks[0]?.id ?? "");
  if (!playbooks.length) return <p className="text-sm text-muted-foreground">No onboarding playbooks yet. Create one under Onboarding, Playbooks.</p>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Select aria-label="Playbook" value={playbookId} onChange={(e) => setPlaybookId(e.target.value)} className="min-w-[200px] flex-1">
          {playbooks.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Button disabled={pending || !playbookId} onClick={() => start(async () => {
          setError(null);
          const r = await startOnboarding(opportunityId, playbookId);
          if (!r.ok) setError(r.error); else router.push(`/onboarding/${r.data.id}`);
        })}>
          <Rocket className="h-4 w-4" /> Start onboarding
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
