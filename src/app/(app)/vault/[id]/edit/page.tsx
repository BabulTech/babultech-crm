import { notFound } from "next/navigation";
import { getSecret, getVaultFormOptions } from "@/server/secrets";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Forbidden } from "@/components/ui";
import { serialize } from "@/lib/utils";
import { SecretForm, type SecretDefaults, type SecretFormOptions } from "../../secret-form";

export default async function EditSecretPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();
  if (!can(user, PERMISSIONS.SECRET_WRITE)) return <Forbidden what="the vault" />;

  const [secret, options] = await Promise.all([getSecret(id), getVaultFormOptions()]);
  if (!secret) notFound();

  // Note what is absent: the value itself. Editing metadata never decrypts the
  // secret, so opening this form does not put a credential on screen and does
  // not appear in the access log as a reveal.
  const defaults = serialize({
    id: secret.id,
    name: secret.name,
    service: secret.service,
    kind: secret.kind,
    environment: secret.environment,
    status: secret.status,
    username: secret.username,
    url: secret.url,
    ownerUserId: secret.ownerUserId,
    projectId: secret.projectId ?? null,
    expiresAt: secret.expiresAt,
    rotationDays: secret.rotationDays,
    lastRotatedAt: secret.lastRotatedAt,
    storedIn: secret.storedIn,
    notes: secret.notes,
    valueHint: secret.valueHint,
  }) as unknown as SecretDefaults;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        backTo={`/vault/${id}`}
        backLabel="Back to the secret"
        title={`Edit ${secret.name}`}
        description={secret.secretNumber as string}
      />
      <SecretForm
        options={serialize(options) as unknown as SecretFormOptions}
        defaults={defaults}
        currentUserId={user.id}
      />
    </div>
  );
}
