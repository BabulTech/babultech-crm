import { redirect } from "next/navigation";
import { requireUser, AuthorizationError } from "@/lib/authz";
import { InternalFrame } from "@/components/internal-frame";
import { PortalFrame } from "@/components/portal-frame";

/**
 * Prospecting is worked by our staff and by partners, on the same screens.
 * Staff get the internal app around it; a partner gets their portal, and the
 * database limits them to their own prospects. Every other internal screen
 * stays closed to partners: (app)'s layout still sends them back.
 */
export default async function ProspectingLayout({ children }: { children: React.ReactNode }) {
  try {
    const user = await requireUser();
    if (user.userType === "CUSTOMER") redirect("/support");
    if (user.userType === "PARTNER" || user.partnerId) return <PortalFrame user={user}>{children}</PortalFrame>;
    return <InternalFrame user={user}>{children}</InternalFrame>;
  } catch (err) {
    if (err instanceof AuthorizationError) redirect("/login");
    throw err;
  }
}
