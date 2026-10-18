import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil, ExternalLink } from "lucide-react";
import { getSecret } from "@/server/secrets";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone,
  Button, Forbidden, DetailRow, Alert, Table, THead, TBody, TR, TH, TD,
} from "@/components/ui";
import { formatDate, formatDateTime, humanize } from "@/lib/utils";
import {
  expiryLevel, expiryPhrase, nextRotationDue, rotationOverdue,
} from "@/lib/secret-expiry";
import { RevealSecret } from "./reveal-secret";

const EXPIRY_TONE = {
  EXPIRED: "danger",
  CRITICAL: "danger",
  WARNING: "warning",
  OK: "success",
  NONE: "neutral",
} as const;

/** How each logged action reads to someone scanning the history. */
const ACTION_LABEL: Record<string, string> = {
  REVEAL: "Value revealed",
  CREATE: "Added to the vault",
  UPDATE: "Details changed",
  ROTATE: "Value replaced",
  REVOKE: "Revoked",
};

export default async function SecretPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await requireUser();
  if (!can(me, PERMISSIONS.SECRET_READ)) return <Forbidden what="the vault" />;

  const secret = await getSecret(id);
  if (!secret) notFound();

  const canWrite = can(me, PERMISSIONS.SECRET_WRITE);
  const level = expiryLevel(secret.expiresAt as string | null);
  const dueDate = nextRotationDue(
    secret.lastRotatedAt as string | null,
    secret.rotationDays as number | null,
    secret.createdAt as string | null,
  );
  const overdue = rotationOverdue(
    secret.lastRotatedAt as string | null,
    secret.rotationDays as number | null,
    secret.createdAt as string | null,
  );

  return (
    <>
      <PageHeader
        backTo="/vault"
        backLabel="Back to the vault"
        title={secret.name as string}
        description={`${secret.secretNumber} · ${secret.service}`}
      >
        {canWrite && (
          <Button asChild variant="outline">
            <Link href={`/vault/${id}/edit`}>
              <Pencil className="h-4 w-4" /> Edit
            </Link>
          </Button>
        )}
      </PageHeader>

      {level === "EXPIRED" && secret.status !== "REVOKED" && (
        <Alert tone="danger">
          This expired on {formatDate(secret.expiresAt as string)}. Anything still
          using it has stopped working, or is about to.
        </Alert>
      )}
      {overdue && secret.status !== "REVOKED" && (
        <Alert tone="warning">
          Due for rotation since {formatDate(dueDate)}. It still works - it has
          simply been live longer than the {String(secret.rotationDays)}-day policy
          set for it.
        </Alert>
      )}
      {secret.status === "REVOKED" && (
        <Alert tone="info">
          This secret is revoked. The record is kept so the history below still
          shows who held it and when.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>The secret</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <RevealSecret secretId={id} envFile={secret.kind === "ENV_FILE"} fileName={`${String(secret.name).replace(/[^A-Za-z0-9._-]+/g, "-")}.env`} />

              <div className="grid gap-4 sm:grid-cols-2">
                <DetailRow
                  label="Where the live copy lives"
                  help="Where the running system reads this from. The first thing you need during an incident."
                >
                  {(secret.storedIn as string) || "—"}
                </DetailRow>
                {secret.kind === "ENV_FILE" ? (
                  <DetailRow label={`Variables (${(secret.envKeys as string[] | null)?.length ?? 0})`} help="The names only, which are searchable from the vault list. The values stay encrypted.">
                    <span className="flex flex-wrap gap-1">
                      {((secret.envKeys as string[] | null) ?? []).map((k) => (
                        <code key={k} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{k}</code>
                      ))}
                    </span>
                  </DetailRow>
                ) : (
                <DetailRow label="Ends with" help="The last few characters, for matching it against the provider's dashboard without revealing it.">
                  {secret.valueHint ? (
                    <code className="font-mono text-sm">…{secret.valueHint as string}</code>
                  ) : (
                    "—"
                  )}
                </DetailRow>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <DetailRow label="Project">
                {secret.project ? (
                  <Link href={`/projects/${secret.project.id}`} className="text-primary hover:underline">{secret.project.name}</Link>
                ) : "BabulTech Internal"}
              </DetailRow>
              <DetailRow label="Service">{secret.service as string}</DetailRow>
              <DetailRow label="Kind">{secret.kind === "ENV_FILE" ? "Environment file (.env)" : humanize(secret.kind as string)}</DetailRow>
              <DetailRow label="Environment">
                <Badge tone={secret.environment === "PRODUCTION" ? "warning" : "neutral"}>
                  {humanize(secret.environment as string)}
                </Badge>
              </DetailRow>
              <DetailRow label="Status">
                <Badge tone={statusTone(secret.status as string)}>
                  {humanize(secret.status as string)}
                </Badge>
              </DetailRow>
              <DetailRow label="Username or account">
                {(secret.username as string) || "—"}
              </DetailRow>
              <DetailRow label="Login URL">
                {secret.url ? (
                  <a
                    href={secret.url as string}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    Open <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  "—"
                )}
              </DetailRow>
            </CardContent>
          </Card>

          {secret.notes ? (
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm">{secret.notes as string}</p>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {secret.accessLog.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  Nothing recorded yet.
                </p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>What happened</TH>
                      <TH>Who</TH>
                      <TH>When</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {secret.accessLog.map((entry) => (
                      <TR key={entry.id}>
                        <TD className="text-sm">
                          {ACTION_LABEL[entry.action] ?? humanize(entry.action)}
                        </TD>
                        <TD className="text-sm text-muted-foreground">
                          {/* The log outlives the person: userId is set null if
                              their account is removed, and the row must stay. */}
                          {entry.user?.fullName ?? "Someone since removed"}
                        </TD>
                        <TD className="whitespace-nowrap text-sm text-muted-foreground">
                          {formatDateTime(entry.accessedAt)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Ownership</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <DetailRow
                label="Owner"
                help="Accountable for renewing and revoking it, which is not necessarily whoever added it."
              >
                {(secret.owner as { fullName?: string })?.fullName ?? "—"}
                {(secret.owner as { email?: string })?.email && (
                  <p className="text-xs text-muted-foreground">
                    {(secret.owner as { email?: string }).email}
                  </p>
                )}
              </DetailRow>
              <DetailRow label="Added by">
                {(secret.createdBy as { fullName?: string })?.fullName ?? "—"}
                <p className="text-xs text-muted-foreground">
                  {formatDate(secret.createdAt as string)}
                </p>
              </DetailRow>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Lifetime</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <DetailRow
                label="Expires"
                help="The provider's deadline. Empty means no known expiry."
              >
                <Badge tone={EXPIRY_TONE[level]}>
                  {expiryPhrase(secret.expiresAt as string | null)}
                </Badge>
                {secret.expiresAt ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatDate(secret.expiresAt as string)}
                  </p>
                ) : null}
              </DetailRow>
              <DetailRow
                label="Rotation policy"
                help="Our own schedule for replacing it, separate from the provider's expiry."
              >
                {secret.rotationDays
                  ? `Every ${String(secret.rotationDays)} days`
                  : "Not rotated on a schedule"}
              </DetailRow>
              <DetailRow label="Last rotated">
                {secret.lastRotatedAt ? formatDate(secret.lastRotatedAt as string) : "Never"}
              </DetailRow>
              {dueDate && (
                <DetailRow label="Next due">
                  <span className={overdue ? "text-red-600 dark:text-red-400" : ""}>
                    {formatDate(dueDate)}
                  </span>
                </DetailRow>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
