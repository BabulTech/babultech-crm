import { Letterhead } from "@/components/letterhead";
import { RichText } from "@/components/rich-text";
import { proposalDate, type ProposalSection } from "@/lib/proposals";

const money = (n: number, c: string) => `${c} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The proposal as the customer sees it: in the editor preview, on their page, and printed to PDF. */
export function ProposalDocument({
  companyName,
  title,
  number,
  version,
  accountName,
  date,
  validUntil,
  sections,
}: {
  companyName: string;
  title: string;
  number: string;
  version: number;
  accountName: string;
  date: string | null;
  validUntil: string | null;
  sections: ProposalSection[];
}) {
  return (
    <article className="proposal-doc rounded-xl border border-gray-200 bg-white p-6 text-[15px] leading-relaxed text-gray-900 shadow-sm sm:p-10 print:border-0 print:p-0 print:shadow-none">
      <header className="mb-8 border-b border-gray-200 pb-6">
        <Letterhead companyName={companyName} />
        <h1 className="mt-6 text-2xl font-semibold sm:text-3xl">{title}</h1>
        <p className="mt-2 text-sm text-gray-600">
          Prepared for <strong className="text-gray-900">{accountName}</strong>
          {date ? ` · ${proposalDate(date)}` : ""} · {number}{version > 1 ? ` v${version}` : ""}
          {validUntil ? ` · Valid until ${proposalDate(validUntil)}` : ""}
        </p>
      </header>
      <div className="space-y-8">
        {sections.map((s, i) => (
          <section key={i} className="break-inside-avoid-page">
            <h2 className="mb-3 text-lg font-semibold text-gray-900">{s.title}</h2>
            {s.kind === "TEXT" ? (
              <RichText value={s.body} className="prose prose-sm max-w-none" />
            ) : s.pricing ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm" data-pricing>
                  <thead className="border-b border-gray-300 text-xs uppercase tracking-wide text-gray-500">
                    <tr><th className="py-2 pr-2">Item</th><th className="py-2 pr-2 text-right">Qty</th><th className="py-2 pr-2 text-right">Price</th><th className="py-2 text-right">Amount</th></tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {s.pricing.lines.map((l, j) => (
                      <tr key={j}>
                        <td className="py-2 pr-2">{l.description}{l.discountPercent ? <span className="ml-1 text-xs text-gray-500">({l.discountPercent}% off)</span> : null}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">{l.quantity}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">{money(l.unitPrice, s.pricing!.currencyCode)}</td>
                        <td className="py-2 text-right tabular-nums">{money(l.lineTotal, s.pricing!.currencyCode)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="text-sm">
                    <tr className="border-t border-gray-300"><td colSpan={3} className="pt-2 text-right text-gray-600">Subtotal</td><td className="pt-2 text-right tabular-nums">{money(s.pricing.subtotal, s.pricing.currencyCode)}</td></tr>
                    {s.pricing.discountAmount > 0 && <tr><td colSpan={3} className="text-right text-gray-600">Discount</td><td className="text-right tabular-nums">-{money(s.pricing.discountAmount, s.pricing.currencyCode)}</td></tr>}
                    {s.pricing.taxAmount > 0 && <tr><td colSpan={3} className="text-right text-gray-600">Tax</td><td className="text-right tabular-nums">{money(s.pricing.taxAmount, s.pricing.currencyCode)}</td></tr>}
                    <tr><td colSpan={3} className="pt-1 text-right font-semibold">Total</td><td className="pt-1 text-right font-semibold tabular-nums">{money(s.pricing.totalAmount, s.pricing.currencyCode)}</td></tr>
                  </tfoot>
                </table>
                {s.pricing.paymentTerms && <p className="mt-3 text-sm text-gray-600">Payment terms: {s.pricing.paymentTerms}</p>}
                <p className="mt-1 text-xs text-gray-400">Quotation {s.pricing.quoteNumber}</p>
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">Choose the deal&apos;s quotation to show the pricing here.</p>
            )}
          </section>
        ))}
      </div>
    </article>
  );
}
