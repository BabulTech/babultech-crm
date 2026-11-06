import { redirect } from "next/navigation";
import { InternalFrame } from "@/components/internal-frame";
import { requireUser, AuthorizationError } from "@/lib/authz";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  try {
    const user = await requireUser();
    // External logins never see the internal app, whatever they type in the
    // address bar. Each portal's layout enforces the reverse, and the database
    // refuses them independently: both fail app_is_internal().
    if (user.userType === "PARTNER" || user.partnerId) redirect("/portal");
    if (user.userType === "CUSTOMER") redirect("/support");

    return <InternalFrame user={user}>{children}</InternalFrame>;
  } catch (err) {
    if (err instanceof AuthorizationError) redirect("/login");
    throw err;
  }
}
