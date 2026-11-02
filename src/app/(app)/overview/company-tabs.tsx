import Link from "next/link";
import { Clock, Coins, Users, Building2, Target, Handshake, LifeBuoy, UserPlus, Database, HardDrive } from "lucide-react";
import { getCompanyInformation } from "@/server/company";
import {
  Button, Card, CardHeader, CardTitle, CardContent,
  StatTile, Badge, Table, THead, TBody, TR, TH, TD, Alert,
} from "@/components/ui";
import { CompanySettingForm } from "../company/setting-form";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

/** 23 MB, 87 kB - storage reads as sizes, not byte counts. */
function bytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** The totals: the organisation's own, counted past every visibility rule. */
export async function OrganisationTab() {
  const { overview } = await getCompanyInformation();
  return (
    <>
      {overview ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Users" value={String(overview.users)} sublabel="Active staff logins" icon={<Users className="h-4 w-4" />} href="/users" />
          <StatTile label="Customers" value={String(overview.customers)} icon={<Building2 className="h-4 w-4" />} href="/accounts" />
          <StatTile label="Deals" value={String(overview.deals)} icon={<Target className="h-4 w-4" />} href="/opportunities" />
          <StatTile label="Partners" value={String(overview.partners)} icon={<Handshake className="h-4 w-4" />} href="/partners" />
          <StatTile label="Cases" value={String(overview.cases)} icon={<LifeBuoy className="h-4 w-4" />} href="/cases" />
          <StatTile label="Leads" value={String(overview.leads)} icon={<UserPlus className="h-4 w-4" />} href="/leads" />
          <StatTile label="Data storage" value={bytes(overview.databaseBytes)} sublabel="The database" icon={<Database className="h-4 w-4" />} />
          <StatTile label="File storage" value={bytes(overview.fileBytes)} sublabel="Uploaded documents and attachments" icon={<HardDrive className="h-4 w-4" />} />
        </div>
      ) : (
        <Alert tone="warning">The totals could not be counted just now.</Alert>
      )}

    </>
  );
}

/** Who we are, the currencies we work in, and our working week. */
export async function CompanyProfileTab() {
  const { setting, currencies, businessHours, accountName } = await getCompanyInformation();
  const defaultHours = businessHours.find((h) => h.isDefault) ?? businessHours[0];
  const base = currencies.find((c) => c.isBase);
  return (
    <>
      <div className="mb-4 flex justify-end gap-2">
        <Button asChild variant="outline">
          <Link href="/company/business-hours">
            <Clock className="h-4 w-4" /> Setup business hours
          </Link>
        </Button>
        <Button asChild>
          <Link href="/company/currencies">
            <Coins className="h-4 w-4" /> Setup currency
          </Link>
        </Button>
      </div>
      {!setting ? (
        <Alert tone="danger">The company settings are missing. They should have been created with the database.</Alert>
      ) : (
        <CompanySettingForm
          setting={setting}
          accountName={accountName}
          currencies={currencies.filter((c) => c.active).map((c) => c.code)}
        />
      )}

      <div className="mt-8 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Business hours</CardTitle>
            <Button asChild size="sm" variant="ghost">
              <Link href="/company/business-hours">Change</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {!defaultHours ? (
              <p className="text-sm text-muted-foreground">No working week set up yet.</p>
            ) : (
              <>
                <p className="text-sm font-medium">{defaultHours.name}</p>
                <p className="mb-3 text-xs text-muted-foreground">{defaultHours.timezone}</p>
                <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-sm">
                  {DAYS.map((day) => {
                    const d = defaultHours.weeklySchedule?.[day];
                    return (
                      <div key={day} className="contents">
                        <dt className="capitalize text-muted-foreground">{day}</dt>
                        <dd className={d ? "tabular-nums" : "text-muted-foreground"}>
                          {d ? `${d.start} – ${d.end}` : "Closed"}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Currencies</CardTitle>
            <Button asChild size="sm" variant="ghost">
              <Link href="/company/currencies">Change</Link>
            </Button>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <THead>
                <TR>
                  <TH>Currency</TH>
                  <TH className="text-right">1 unit = {base?.code ?? "PKR"}</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {currencies.map((c) => (
                  <TR key={c.code}>
                    <TD>
                      <span className="font-mono text-sm">{c.code}</span>
                      <span className="ml-2 text-sm text-muted-foreground">{c.name}</span>
                    </TD>
                    <TD className="text-right tabular-nums">{Number(c.exchangeRate).toLocaleString("en-PK", { maximumFractionDigits: 4 })}</TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        {c.isBase && <Badge tone="info">Base</Badge>}
                        {c.code === setting?.defaultCurrency && <Badge tone="success">Default</Badge>}
                        {c.code === setting?.corporateCurrency && <Badge tone="neutral">Corporate</Badge>}
                        {!c.active && <Badge tone="warning">Off</Badge>}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
