"use client";

import { useState, useTransition } from "react";
import { SignaturePad } from "@/components/signature-pad";
import { respondToProposal } from "@/server/proposals";

export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-100">
      Download PDF
    </button>
  );
}

/** Accept with a typed name and signature, ask for changes, or decline. */
export function RespondForm({ token }: { token: string }) {
  const [mode, setMode] = useState<"ACCEPT" | "CHANGES" | "DECLINE">("ACCEPT");
  const [name, setName] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const tab = (m: typeof mode, label: string) => (
    <button type="button" onClick={() => { setMode(m); setError(null); }}
      className={`rounded-md px-3 py-1.5 text-sm font-medium ${mode === m ? "bg-gray-900 text-white" : "border border-gray-300 bg-white text-gray-800"}`}>
      {label}
    </button>
  );

  return (
    <form
      className="mt-6 space-y-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm"
      data-respond
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const payload = mode === "ACCEPT" ? { action: mode, name, signature: signature ?? "", agree } : { action: mode, name, comment };
          const r = await respondToProposal(token, payload);
          if (!r.ok) { setError(r.error); return; }
          window.location.reload();
        });
      }}
    >
      <h2 className="text-lg font-semibold">Your response</h2>
      <div className="flex flex-wrap gap-2">
        {tab("ACCEPT", "Accept")}
        {tab("CHANGES", "Request changes")}
        {tab("DECLINE", "Decline")}
      </div>
      <label className="block text-sm">
        <span className="font-medium">Your full name</span>
        <input name="name" value={name} onChange={(e) => setName(e.target.value)} required
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900" />
      </label>
      {mode === "ACCEPT" ? (
        <>
          <div className="text-sm">
            <span className="font-medium">Your signature</span>
            <div className="mt-1"><SignaturePad onChange={setSignature} label="Your signature" /></div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="agree" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>I have read this proposal and accept it, including its pricing and terms, on behalf of my organisation.</span>
          </label>
        </>
      ) : (
        <label className="block text-sm">
          <span className="font-medium">{mode === "CHANGES" ? "What would you like changed?" : "Reason (optional)"}</span>
          <textarea name="comment" rows={4} value={comment} onChange={(e) => setComment(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900" />
        </label>
      )}
      {error && <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900" role="alert">{error}</p>}
      <button type="submit"
        disabled={pending || !name.trim() || (mode === "ACCEPT" && (!signature || !agree)) || (mode === "CHANGES" && !comment.trim())}
        className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {pending ? "Sending…" : mode === "ACCEPT" ? "Accept the proposal" : mode === "CHANGES" ? "Send my request" : "Decline the proposal"}
      </button>
      {mode === "ACCEPT" && <p className="text-xs text-gray-500">The time, your device and the exact version you accepted are recorded with your signature.</p>}
    </form>
  );
}
