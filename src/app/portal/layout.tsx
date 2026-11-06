import { redirect } from "next/navigation";
import { PortalFrame } from "@/components/portal-frame";
import { requireUser, AuthorizationError } from "@/lib/authz";

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

  return <PortalFrame user={user}>{children}</PortalFrame>;
}
