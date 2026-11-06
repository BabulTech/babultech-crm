import { PortalShell } from "@/components/portal-shell";
import { datePrefsFor, type SessionUser } from "@/lib/authz";
import { getPartnerProfile } from "@/server/portal";
import { CurrencyContextProvider } from "@/components/currency-context-provider";
import { DatePrefsProvider } from "@/components/date-prefs-provider";
import { ensureCurrencyContext } from "@/lib/currency-loader";
import { ViewAsBanner } from "@/components/view-as-banner";

/** The partner portal around a page: its menu, the partner's name, the login. */
export async function PortalFrame({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  // The currencies and rates the server formats money with, handed to the
  // browser too, so money shown by the portal's own screens - the deal's
  // products and services, a quote being priced - renders the same text on
  // both and hydrates cleanly, as in our app's layout.
  const [partner, currencies] = await Promise.all([getPartnerProfile(), ensureCurrencyContext()]);

  return (
    <CurrencyContextProvider value={currencies}>
      <ViewAsBanner />
      <PortalShell
        partner={{
          displayName: partner.displayName,
          partnerNumber: partner.partnerNumber,
          tier: partner.tier,
        }}
        user={{ fullName: user.fullName, email: user.email }}
        isAdmin={user.portalRole === "ADMIN"}
      >
        <DatePrefsProvider value={datePrefsFor(user)}>{children}</DatePrefsProvider>
      </PortalShell>
    </CurrencyContextProvider>
  );
}
