const LABELS: Record<string, string> = {
  displayName: "Partner name", email: "Email", phone: "Phone", website: "Website", territory: "Territory",
  taxNumber: "Tax number", defaultCommissionPercent: "Commission rate (%)", withholdingTaxPercent: "Withholding tax (%)",
  payoutCurrencyCode: "Payout currency", bankDetails: "Bank details",
};

const show = (v: unknown) => {
  if (v && typeof v === "object") return Object.values(v).filter(Boolean).join(" · ") || "—";
  return v === "" || v === null || v === undefined ? "—" : String(v);
};

/** Old against new. Works in both the portal and the admin screen. */
export function ChangeList({ changes }: { changes: Record<string, { from: unknown; to: unknown } | undefined> }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr><th className="py-1 pr-3 font-medium">Field</th><th className="py-1 pr-3 font-medium">Now</th><th className="py-1 font-medium">Requested</th></tr>
      </thead>
      <tbody>
        {Object.entries(changes).map(([field, c]) => (
          <tr key={field} className="border-t align-top">
            <td className="py-1 pr-3">{LABELS[field] ?? field}</td>
            <td className="py-1 pr-3 text-muted-foreground">{show(c?.from)}</td>
            <td className="py-1 font-medium">{show(c?.to)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
