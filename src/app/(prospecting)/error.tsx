"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert, RotateCw } from "lucide-react";
import { Button, Card, CardContent } from "@/components/ui";

/**
 * Authorization failures reach here as thrown AuthorizationErrors. React
 * scrubs error messages in production, so we key off the digest-free name
 * where we have it and otherwise show the neutral version — either way the
 * user gets a sentence rather than a stack trace.
 *
 * Two failures arrive here that look alike and need opposite responses:
 *
 *   - "Not signed in" — the session is gone or could not be refreshed. There is
 *     nothing to explain and nothing to retry; the person needs the login page.
 *     The layout already redirects for this, but a layout and the page beneath
 *     it render in parallel, so a page's own requireUser() can throw before the
 *     layout's redirect lands. That race is what put a raw AuthorizationError
 *     on screen instead of the login form, and it is why the redirect is
 *     repeated here rather than left to the layout alone.
 *
 *   - "You do not have permission" — the session is fine and the role is not.
 *     Redirecting would be wrong: signing in again changes nothing, and
 *     bouncing someone to a login form they are already past reads as a bug.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  // Message text is scrubbed in production builds, so the name is checked
  // first and the message only as a fallback for development.
  const signedOut =
    error.message.includes("Not signed in") ||
    error.message.includes("session has ended") ||
    error.message.includes("Account is not active");

  const denied = !signedOut && (
    error.name === "AuthorizationError" ||
    error.message.includes("permission")
  );

  useEffect(() => {
    // replace(), not push(): the page that threw should not sit in the history
    // for the back button to return to, because going back would throw again.
    if (signedOut) router.replace("/login");
  }, [signedOut, router]);

  if (signedOut) {
    // Rendered for the moment before the redirect commits. No card and no
    // error language — this is a routine expired session, not a failure, and
    // dressing it up as one is alarming for something that happens every day.
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-muted-foreground">Taking you to the sign-in page…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center justify-center py-20 text-center">
      <Card className="w-full">
        <CardContent className="flex flex-col items-center gap-4 p-8">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-muted">
            <ShieldAlert className="h-6 w-6 text-muted-foreground" />
          </span>

          <div>
            <h1 className="text-lg font-semibold">
              {denied ? "You do not have access to this" : "Something went wrong"}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {denied
                ? "Your role does not include this screen. If you think it should, ask an administrator to change your role."
                : "The page could not be loaded. Trying again often works; if it does not, the error has been logged."}
            </p>
          </div>

          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/">Back to the dashboard</Link>
            </Button>
            {!denied && (
              <Button onClick={reset}>
                <RotateCw className="h-4 w-4" /> Try again
              </Button>
            )}
          </div>

          {error.digest && (
            <p className="text-xs text-muted-foreground">Reference: {error.digest}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
