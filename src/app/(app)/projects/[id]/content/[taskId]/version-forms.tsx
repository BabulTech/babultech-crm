"use client";
import { softReload } from "@/components/soft-navigation";
import { useRef, useState, useTransition } from "react";
import { Button, Input, Select, Textarea } from "@/components/ui";
import { publicationInputToIso } from "@/lib/content-versions";
import { mutateContentVersion } from "@/server/content-versions";

export function VersionActionForm({ kind, taskId, versionId, expected = 0, planRevision = 1, stage = "INTERNAL" }: { kind: "version" | "review" | "publication"; taskId?: string; versionId?: string; expected?: number; planRevision?: number; stage?: "INTERNAL" | "CLIENT" }) {
 const requestId = useRef<string | null>(null); const [pending, start] = useTransition(); const [message, setMessage] = useState(""); const [saved, setSaved] = useState(false);
 if (saved) return <p role="status">Saved. Refreshing the version history.</p>;
 return <form className="grid gap-3 mt-4" onSubmit={event => {
 event.preventDefault(); const form = new FormData(event.currentTarget); requestId.current ??= crypto.randomUUID(); setMessage("");
 const get = (name: string) => String(form.get(name) ?? "").trim();
 const input = kind === "version" ? { id: requestId.current, taskId, expected, planRevision, copy: get("copy"), assetUrl: get("assetUrl") || null, assetSha: get("assetSha") || null }
 : kind === "review" ? { id: requestId.current, versionId, stage, decision: get("decision"), evidence: get("evidence"), client: stage === "CLIENT" ? get("client") : null }
 : { id: requestId.current, versionId, url: get("url"), publishedAt: publicationInputToIso(get("publishedAt")) };
 start(async () => { try { const result = await mutateContentVersion(kind, input); if (!result.ok) { setMessage(result.error); return; } setSaved(true); softReload(); /* a full load: see components/log-touch-button.tsx */ } catch { setMessage("Save could not be confirmed. Retry with the same details or refresh to check history."); } });
 }}>
 {kind === "version" && <>
 <label>Exact caption / script / copy<Textarea name="copy" required maxLength={20000} disabled={pending} /></label>
 <label>Asset version URL (optional)<Input name="assetUrl" type="url" maxLength={2048} disabled={pending} /></label>
 <label>Asset file SHA-256 (required with asset URL)<Input name="assetSha" minLength={64} maxLength={64} pattern="[0-9a-fA-F]{64}" disabled={pending} /></label>
 <p className="text-sm text-muted-foreground">Use a frozen asset version and its file hash. This app stores the reference and hash; it does not download or verify the file. Changed copy or media needs a new version.</p>
 </>}
 {kind === "review" && <>
 <label>{stage === "CLIENT" ? "Received client decision" : "Internal review"}<Select aria-label={stage === "CLIENT" ? "Received client decision" : "Internal review"} name="decision" disabled={pending}><option value="CHANGES_REQUESTED">Changes requested</option><option value="APPROVED">Approved</option></Select></label>
 {stage === "CLIENT" && <label>Client approver name<Input name="client" required maxLength={200} disabled={pending} /></label>}
 <label>{stage === "CLIENT" ? "Client decision evidence / reference and date" : "Review notes and asset verification evidence"}<Textarea name="evidence" required maxLength={4000} disabled={pending} /></label>
 <p className="text-sm text-muted-foreground">Review this exact version. If it has an asset, manually check the referenced file and SHA-256. Client decisions are recorded by staff from received evidence; this is not a client portal signature.</p>
 <label className="flex gap-2 text-sm"><input type="checkbox" required disabled={pending} /> I checked this version and any referenced asset before recording the decision.</label>
 </>}
 {kind === "publication" && <>
 <label>Live publication URL<Input name="url" type="url" required maxLength={2048} disabled={pending} /></label>
 <label>Actual publication time (Pakistan time)<Input name="publishedAt" type="datetime-local" step={1} required disabled={pending} /></label>
 <p className="text-sm text-muted-foreground">Record an already published item after its approvals were recorded. This action does not post content or verify the live page.</p>
 </>}
 {message && <p role="alert" className="text-sm text-red-600">{message}</p>}<Button type="submit" disabled={pending}>{pending ? "Saving…" : kind === "version" ? "Save new version" : kind === "review" ? "Record version review" : "Record publication evidence"}</Button>
 </form>;
}
