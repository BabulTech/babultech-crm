import { redirect } from "next/navigation";
import { signInWithCredentials } from "@/lib/auth";
import { supabaseSession, supabaseAdmin } from "@/lib/supabase";
import { Card, Alert } from "@/components/ui";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const db = await supabaseSession();

  // A signed-in visitor belongs inside the application, not on this page.
  //
  // But a token only proves somebody authenticated once; it does not prove
  // they still have an account. Redirecting on the token alone produced an
  // infinite loop: this page sent them to /, requireUser() found no active
  // app_user and threw, and its handler sent them back here. That happens to
  // anybody whose account is deactivated, and to anybody holding a session
  // for a login that has since been removed.
  //
  // So the account is confirmed before redirecting, and a session with no
  // usable account is ended here - which is the only place that can end it,
  // since every page inside the application refuses them first.
  const { data: claims } = await db.auth.getClaims();
  let staleSession = false;

  if (claims) {
    const userId = (claims.claims?.sub ?? null) as string | null;
    const { data: account } = userId
      ? await supabaseAdmin()
          .from("app_user")
          .select("id, status, deletedAt")
          .eq("id", userId)
          .maybeSingle()
      : { data: null };

    if (account && account.status === "ACTIVE" && !account.deletedAt) {
      redirect("/");
    }

    // Ends the loop rather than bouncing them around it.
    await db.auth.signOut();
    staleSession = true;
  }

  const { error } = await searchParams;

  async function login(formData: FormData): Promise<{ start: string }> {
    "use server";
    const result = await signInWithCredentials(
      String(formData.get("email") ?? ""),
      String(formData.get("password") ?? ""),
    );

    // redirect() throws, so it must sit outside any try/catch that would
    // swallow the control-flow exception.
    if (!result.ok) redirect(`/login?error=${result.reason}`);

    // Their chosen start page, if they have one. Only a path inside the app:
    // the column refuses anything else, and it is checked again here. Read with
    // the account check in signInWithCredentials, not as a round trip after it.
    const start = result.startPage && /^\/[a-z0-9/_-]*$/.test(result.startPage) ? result.startPage : "/";
    // Returned, not redirected: the form navigates itself, so it can show the
    // app's skeleton the moment the password is accepted.
    return { start };
  }

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-muted/40 p-4">
      {/* Two soft washes behind the card. Decorative only - the form reads the
          same with them stripped out. */}
      <div
        className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-primary/10 blur-3xl"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -bottom-40 -right-32 h-96 w-96 rounded-full bg-blue-500/10 blur-3xl"
        aria-hidden
      />

      <Card className="relative w-full max-w-sm p-7 shadow-lg">
        <div className="mb-7 text-center">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-primary text-base font-bold text-primary-foreground shadow-md shadow-primary/20">
            BT
          </span>
          <h1 className="text-xl font-semibold tracking-tight">BabulTech CRM</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to continue</p>
        </div>

        {staleSession && !error && (
          <div className="mb-4">
            <Alert tone="warning">
              You were signed in, but that account is no longer active. Sign in with another
              one, or ask an administrator to reactivate it.
            </Alert>
          </div>
        )}

        {error && (
          <div className="mb-4">
            <Alert tone="danger">
              {error === "inactive"
                ? "That account is not active. Contact an administrator."
                : "That email and password combination did not work."}
            </Alert>
          </div>
        )}

        <LoginForm action={login} />
      </Card>
    </div>
  );
}
