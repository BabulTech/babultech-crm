import Link from "next/link";
import { Plus, KeyRound, AlertTriangle, RotateCw } from "lucide-react";
import { listSecrets, isVaultReady, listVaultProjects } from "@/server/secrets";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import {
  PageHeader, Card, Table, THead, TBody, TR, TH, TD, Badge, statusTone,
  EmptyState, StatTile, Input, Select, Button, Forbidden, Alert,
} from "@/components/ui";
import { humanize } from "@/lib/utils";
import { expiryLevel, expiryPhrase, rotationOverdue } from "@/lib/secret-expiry";

const ENVIRONMENTS = ["PRODUCTION", "STAGING", "DEVELOPMENT", "SHARED"];
const STATUSES = ["ACTIVE", "ROTATING", "REVOKED"];

/** Expiry urgency, as a badge tone. */
const EXPIRY_TONE = {
  EXPIRED: "danger",
  CRITICAL: "danger",
  WARNING: "warning",
  OK: "success",
  NONE: "neutral",
} as const;

export default async function VaultPage({
  searchParams,
}: {
  searchParams: Promise<{
    search?: string;
    environment?: string;
    status?: string;
    project?: string;
  }>;
}) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.SECRET_READ)) return <Forbidden what="the vault" />;

  const params = await searchParams;
  const [secrets, vaultReady, projects] = await Promise.all([
    listSecrets(params),
    isVaultReady(),
    listVaultProjects(),
  ]);

  const canWrite = can(me, PERMISSIONS.SECRET_WRITE);

  const live = secrets.filter((s) => s.status !== "REVOKED");
  const expired = live.filter((s) => expiryLevel(s.expiresAt) === "EXPIRED");
  const expiringSoon = live.filter((s) =>
    ["CRITICAL", "WARNING"].includes(expiryLevel(s.expiresAt)),
  );
  const dueRotation = live.filter((s) =>
    rotationOverdue(s.lastRotatedAt, s.rotationDays, s.createdAt),
  );

  return (
    <>
      <PageHeader
        title="Vault"
        description="API keys, passwords and service logins - who owns each one, when it expires, and who has looked at it."
      >
        {canWrite && (
          <Button asChild>
            <Link href="/vault/new">
              <Plus className="h-4 w-4" /> Add a secret
            </Link>
          </Button>
        )}
      </PageHeader>

      {!vaultReady && (
        <Alert tone="danger">
          <strong>SECRET_VAULT_KEY is not set.</strong> Stored values cannot be
          encrypted or read until it is. Generate one with{" "}
          <code className="rounded bg-black/10 px-1">openssl rand -base64 32</code>{" "}
          and set it in the environment. Keep a copy somewhere safe - if it is
          lost, every stored value is unrecoverable.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Live secrets" value={String(live.length)} icon={<KeyRound className="h-4 w-4" />} />
        <StatTile
          label="Expired"
          value={String(expired.length)}
          tone={expired.length ? "danger" : "success"}
          icon={<AlertTriangle className="h-4 w-4" />}
          help="Past their expiry date. Whatever uses these has either broken already or is about to."
        />
        <StatTile
          label="Expiring within 30 days"
          value={String(expiringSoon.length)}
          tone={expiringSoon.length ? "warning" : "success"}
          help="Renew these before they lapse."
        />
        <StatTile
          label="Due for rotation"
          value={String(dueRotation.length)}
          tone={dueRotation.length ? "warning" : "neutral"}
          icon={<RotateCw className="h-4 w-4" />}
          help="Older than their own rotation policy. Nothing breaks, but they have been live longer than we said they should be."
        />
      </div>

      <Card className="mt-6">
        <form className="flex flex-wrap items-end gap-3 border-b p-4">
          <div className="min-w-[220px] flex-1">
            <Input
              name="search"
              placeholder="Search name, service, username or a variable like RESEND_API_KEY…"
              defaultValue={params.search}
            />
          </div>
          <Select name="project" defaultValue={params.project ?? ""} className="w-56">
            <option value="">All projects</option>
            <option value="internal">BabulTech Internal</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
          <Select name="environment" defaultValue={params.environment ?? ""} className="w-48">
            <option value="">All environments</option>
            {ENVIRONMENTS.map((e) => (
              <option key={e} value={e}>{humanize(e)}</option>
            ))}
          </Select>
          <Select name="status" defaultValue={params.status ?? ""} className="w-40">
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{humanize(s)}</option>
            ))}
          </Select>
          <Button type="submit" variant="secondary">Filter</Button>
        </form>

        {secrets.length === 0 ? (
          <EmptyState
            title="Nothing in the vault yet"
            description="Record the keys and logins the business depends on, so there is one place that answers what expires when and who owns it."
            action={
              canWrite ? (
                <Button asChild>
                  <Link href="/vault/new">Add the first secret</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Secret</TH>
                <TH>Project</TH>
                <TH>Service</TH>
                <TH priority="secondary">Environment</TH>
                <TH priority="tertiary">Owner</TH>
                <TH>Expires</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {secrets.map((s) => {
                const level = expiryLevel(s.expiresAt);
                const overdue = rotationOverdue(s.lastRotatedAt, s.rotationDays, s.createdAt);

                return (
                  <TR key={s.id}>
                    <TD>
                      <Link href={`/vault/${s.id}`} className="font-medium hover:underline">
                        {s.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {s.secretNumber} · {s.kind === "ENV_FILE" ? `.env file · ${(s.envKeys as string[] | null)?.length ?? 0} variables` : humanize(s.kind)}
                        {s.valueHint && ` · ends ${s.valueHint}`}
                      </p>
                    </TD>
                    <TD className="text-sm">
                      {s.project ? (
                        <Link href={`/projects/${s.project.id}`} className="hover:underline">{s.project.name}</Link>
                      ) : (
                        <span className="text-muted-foreground">BabulTech Internal</span>
                      )}
                    </TD>
                    <TD className="text-sm">
                      {s.service}
                      {s.username && (
                        <p className="text-xs text-muted-foreground">{s.username}</p>
                      )}
                    </TD>
                    <TD priority="secondary">
                      <Badge tone={s.environment === "PRODUCTION" ? "warning" : "neutral"}>
                        {humanize(s.environment)}
                      </Badge>
                    </TD>
                    <TD priority="tertiary" className="text-sm text-muted-foreground">
                      {s.owner?.fullName}
                    </TD>
                    <TD className="whitespace-nowrap text-sm">
                      <Badge tone={EXPIRY_TONE[level]}>{expiryPhrase(s.expiresAt)}</Badge>
                      {overdue && (
                        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                          Rotation overdue
                        </p>
                      )}
                    </TD>
                    <TD>
                      <Badge tone={statusTone(s.status)}>{humanize(s.status)}</Badge>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
