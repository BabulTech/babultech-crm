import { redirect } from "next/navigation";
import { PortalShell } from "@/components/portal-shell";
import { requireUser, AuthorizationError, datePrefsFor } from "@/lib/authz";
import { getPartnerProfile } from "@/server/portal";
import { CurrencyContextProvider } from "@/components/currency-context-provider";
import { DatePrefsProvider } from "@/components/date-prefs-provider";
import { ensureCurrencyContext } from "@/lib/currency-loader";
import { ViewAsBanner } from "@/components/view-as-banner";

/**
 * The portal's front door, and half of the isolation between internal and
 * external users:
 *
 *   - no session          → /login
 *   - session, customer   → /support
 *   - session, no partner → / (an employee wandered in)
 *   - session + partner   → the portal
 *
 * The other half lives in the internal app's layout, which sends partner users
 * here. Neither side relies on the other, so a mistake in one does not open
 * the other.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof AuthorizationError) redirect("/login");
    throw err;
  }

  if (user.userType === "CUSTOMER") redirect("/support");
  if (!user.partnerId) redirect("/");

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
