import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import Link from "next/link";
import { PageHeader, Forbidden, Alert, Button } from "@/components/ui";
import { getSettings } from "@/server/settings";
import { CurrencyList, TaxRateList, NamedList } from "./settings-lists";
import { EmailSettingsPanel } from "./email-settings";
import { getEmailSettings } from "@/server/email";
import { SlaPolicies } from "./sla-policies";
import { listSlaPolicies, listBusinessHours } from "@/server/sla";
import { getPicklistsForAdmin } from "@/server/picklists";
import { listRoles } from "@/server/roles";
import { RolesPanel } from "./roles-panel";
import { PicklistEditor } from "./picklist-editor";

export default async function SettingsPage() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) return <Forbidden what="settings" />;

  const [
    { currencies, taxRates, departments, caseCategories, expenseCategories, campaignTypes },
    emailSettings,
    slaPolicies,
    businessHours,
    picklists,
    roles,
  ] = await Promise.all([
    getSettings(), getEmailSettings(), listSlaPolicies(), listBusinessHours(), getPicklistsForAdmin(),
    listRoles(),
  ]);

  const everythingEmpty =
    currencies.length === 0 && taxRates.length === 0 && departments.length === 0;

  return (
    <>
      <PageHeader
        title="Settings"
        description="The lists every dropdown in the app is built from. Change them here and the forms follow."
      >
        <Button asChild variant="outline"><Link href="/settings/automation">Approval and automatic rules</Link></Button>
        <Button asChild variant="outline"><Link href="/settings/numbering">Record numbering</Link></Button>
        <Button asChild variant="outline"><Link href="/settings/integrations">Webhooks and integrations</Link></Button>
        <Button asChild variant="outline"><Link href="/settings/email-templates">System emails</Link></Button>
      </PageHeader>

      {everythingEmpty && (
        <div className="mb-6">
          <Alert tone="warning">
            All of these lists are empty. If you expected data here, the reference tables may
            not have read policies applied yet - see supabase/migrations.
          </Alert>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <RolesPanel roles={roles} canManage={can(me, PERMISSIONS.ROLE_MANAGE)} />
        <PicklistEditor lists={picklists} />
        <SlaPolicies policies={slaPolicies} businessHours={businessHours} />
        <EmailSettingsPanel values={emailSettings} />
        <CurrencyList rows={currencies} />
        <TaxRateList rows={taxRates} />
        <NamedList
          kind="department"
          title="Departments"
          description="Organizational labels on user records. Reporting-line visibility is controlled by Reports to, not this department label."
          rows={departments}
        />
        <NamedList
          kind="caseCategory"
          title="Case categories"
          description="How support cases are classified."
          rows={caseCategories}
        />
        <NamedList
          kind="expenseCategory"
          title="Expense categories"
          description="Applied when recording an expense."
          rows={expenseCategories}
        />
        <NamedList
          kind="campaignType"
          title="Campaign types"
          description="The kinds of campaign you run. Also addable from the campaign form itself."
          rows={campaignTypes}
        />
      </div>
    </>
  );
}
