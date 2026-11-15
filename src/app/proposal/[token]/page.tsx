import type { Metadata } from "next";
import { getProposalForCustomer } from "@/server/proposals";
import { ProposalDocument } from "@/components/proposal-document";
import { proposalDate } from "@/lib/proposals";
import { RespondForm, PrintButton } from "./respond-form";

// A proposal link must never reach a search index.
export const metadata: Metadata = { title: "Proposal", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Where a customer reads a proposal, downloads it as a PDF (print), and
 * accepts it, asks for changes or declines - without a login. The link is the
 * only key; an unknown or replaced one says nothing about whether it existed.
 */
export default async function CustomerProposalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = await getProposalForCustomer(token);

  if (!p || p.status === "SUPERSEDED") {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">This proposal link is not valid</h1>
        <p className="mt-3 text-gray-600">It may have been replaced by a newer version. Please use the most recent email from us, or contact the person who sent it.</p>
      </Shell>
    );
  }

  const answered = ["ACCEPTED", "DECLINED"].includes(p.status);
  return (
    <Shell>
      <div className="mb-4 flex justify-end print:hidden"><PrintButton /></div>
      <ProposalDocument
        companyName={p.companyName} title={p.title} number={p.proposalNumber} version={p.version}
        accountName={p.accountName} date={p.sentAt?.slice(0, 10) ?? null} validUntil={p.validUntil} sections={p.sections}
      />

      {p.status === "ACCEPTED" && (
        <div className="mt-6 rounded-xl border border-green-300 bg-green-50 p-4 text-green-900" data-proposal-result>
          <p className="font-medium">Accepted by {p.acceptedName} on {proposalDate(p.acceptedAt)}.</p>
          <p className="mt-1 text-sm">Thank you. {p.owner?.fullName ?? "We"} will be in touch about the next steps.</p>
        </div>
      )}
      {p.status === "DECLINED" && (
        <div className="mt-6 rounded-xl border border-gray-300 bg-gray-100 p-4 text-gray-800" data-proposal-result>
          <p className="font-medium">You declined this proposal.</p>
          <p className="mt-1 text-sm">If you change your mind, please contact {p.owner?.fullName ?? "us"}.</p>
        </div>
      )}
      {p.status === "CHANGES_REQUESTED" && (
        <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 print:hidden" data-proposal-result>
          <p className="font-medium">You asked for changes.</p>
          <p className="mt-1 text-sm">{p.customerComment}</p>
          <p className="mt-1 text-sm">We will send you an updated version. You can still accept this one below.</p>
        </div>
      )}
      {!answered && (p.expired ? (
        <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 print:hidden">
          This proposal expired on {proposalDate(p.validUntil)}. Please contact {p.owner?.fullName ?? "us"} for an updated one.
        </div>
      ) : (
        <div className="print:hidden"><RespondForm token={token} /></div>
      ))}

      {p.owner && (
        <p className="mt-8 text-center text-sm text-gray-500 print:hidden">
          Questions? Contact {p.owner.fullName}{p.owner.jobTitle ? `, ${p.owner.jobTitle}` : ""} · <a className="underline" href={`mailto:${p.owner.email}`}>{p.owner.email}</a>{p.owner.phone ? ` · ${p.owner.phone}` : ""}
        </p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-gray-50 text-gray-900 print:bg-white">
      <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 print:max-w-none print:p-0">{children}</div>
    </main>
  );
}
