import { PermissionsProvider } from "@/components/permissions";
import { AppShell } from "@/components/app-shell";
import { PageGuide } from "@/components/page-guide";
import { can, PERMISSIONS, datePrefsFor, type SessionUser } from "@/lib/authz";
import { PicklistProvider } from "@/components/picklist";
import { getPicklistMap } from "@/server/picklists";
import { CurrencyContextProvider } from "@/components/currency-context-provider";
import { DatePrefsProvider } from "@/components/date-prefs-provider";
import { ensureCurrencyContext } from "@/lib/currency-loader";
import { ViewAsBanner } from "@/components/view-as-banner";
import { rememberSchedulerAddress } from "@/lib/scheduler-address";
import { holdsEquipment } from "@/server/inventory";


/** The internal app around a page: its menu, guides and providers. */
export async function InternalFrame({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  // The scheduler learns where the live site is from its first visit.
  await rememberSchedulerAddress();
  // The configurable dropdown values, loaded once for every form.
  const [picklists, currencies, holdsItems] = await Promise.all([
    getPicklistMap(),
    ensureCurrencyContext(),
    holdsEquipment().catch(() => false),
  ]);
  // Anyone holding a company item sees My equipment, whatever their role.
  const navPermissions = holdsItems ? [...user.permissions, "asset:mine"] : user.permissions;

  return (
    <>
    <ViewAsBanner />
    <AppShell
      user={{ fullName: user.fullName, email: user.email, roleName: user.roleName }}
      isAdmin={can(user, PERMISSIONS.ADMIN)}
      permissions={navPermissions}
    >
      {/* In the layout rather than on each page: eighty pages would each need
          the same import and the same placement, and any one of them could be
          forgotten. The guide keys off the pathname, so it knows which screen
          it is on without being told. */}
      <PageGuide />
      {/* The browser formats money with the same rates the server just used,
          or the two would render different text and fail to hydrate. */}
      <CurrencyContextProvider value={currencies}>
        <DatePrefsProvider value={datePrefsFor(user)}>
          <PermissionsProvider value={user.permissions}>
            <PicklistProvider value={picklists}>{children}</PicklistProvider>
          </PermissionsProvider>
        </DatePrefsProvider>
      </CurrencyContextProvider>
    </AppShell>
    </>
  );
}
