import * as XLSX from "xlsx";

/** The import template's columns, in order, with what goes in each. */
export const TEMPLATE_COLUMNS: { header: string; width: number; help: string }[] = [
  { header: "Item name*", width: 28, help: "How people recognise it, e.g. Dell Latitude 5440, Ceiling fan, LED bulb 18W." },
  { header: "Type*", width: 22, help: "From the Lists sheet. A new name creates a new type (set Category and Tracked for it)." },
  { header: "Category", width: 14, help: "Only needed for a new type: Hardware, Software, Furniture, Electrical, Appliance, Other." },
  { header: "Tracked", width: 14, help: "Only needed for a new type: One by one (laptops) or Counted (bulbs, chairs)." },
  { header: "Quantity", width: 10, help: "Default 1. For a one-by-one type, 3 creates 3 separate items. For a counted type, the number at that place." },
  { header: "Brand", width: 14, help: "Optional." },
  { header: "Model", width: 16, help: "Optional." },
  { header: "Serial number", width: 18, help: "Optional. Only with Quantity 1 on a one-by-one type - one row per serial." },
  { header: "Kept at", width: 18, help: "The place it lives, e.g. Main office, Store room. A new place is created." },
  { header: "Condition", width: 13, help: "New, Good (default), Needs repair, Broken." },
  { header: "Given to (person)", width: 24, help: "Who has it now: their CRM login email or exact full name. Leave empty if nobody." },
  { header: "Given to (place)", width: 18, help: "Or the room it is installed in, e.g. Conference room. Not both." },
  { header: "Quantity given", width: 13, help: "Optional. How many of Quantity are with that person or place. Default all." },
  { header: "How we got it", width: 14, help: "Already had (default), Gift, or Purchased (then Expense number is required)." },
  { header: "Purchase date*", width: 15, help: "When it was bought or received. Best guess is fine for older items. 2024-03-15 or 15/03/2024." },
  { header: "Cost of each*", width: 13, help: "Price of one, digits only. Estimate for older items." },
  { header: "Currency", width: 9, help: "Default PKR." },
  { header: "Bought from", width: 20, help: "Optional. Shop or supplier." },
  { header: "Invoice / receipt no.", width: 18, help: "Optional." },
  { header: "Expense number", width: 17, help: "Optional. An expense already in the CRM that paid for it, e.g. EXP-2026-00012. Links the money." },
  { header: "Purchase details", width: 28, help: "Optional. Anything worth knowing about the purchase." },
  { header: "Warranty ends", width: 14, help: "Optional date." },
  { header: "Licence renews", width: 14, help: "Optional date, for software and subscriptions." },
  { header: "Notes", width: 24, help: "Optional." },
];

const EXAMPLES: (string | number)[][] = [
  ["Example: Dell Latitude 5440", "Laptop", "", "", 1, "Dell", "Latitude 5440", "5CG1234XYZ", "Main office", "Good", "ali@babultech.com", "", "", "Already had", "2024-03-15", 185000, "PKR", "Hafeez Centre", "INV-889", "", "With charger and bag", "2026-03-15", "", ""],
  ["Example: HP 24\" monitor", "Monitor / LED screen", "", "", 4, "HP", "M24f", "", "Main office", "Good", "", "", "", "Already had", "2023-11-01", 32000, "", "", "", "", "", "", "", "4 separate monitors, serials added later"],
  ["Example: Ceiling fan", "Ceiling fan", "", "", 6, "GFC", "", "", "", "Good", "", "Main office", "", "Already had", "2022-06-01", 9500, "", "", "", "", "", "", "", ""],
  ["Example: LED bulb 18W", "Bulb / tube light", "", "", 30, "Philips", "", "", "Store room", "New", "", "", "", "Already had", "2025-01-10", 450, "", "", "", "", "", "", "", "Spares"],
  ["Example: Workstation desk", "Workstation", "Furniture", "Counted", 8, "", "", "", "Main office", "Good", "", "", "", "Already had", "2022-01-01", 25000, "", "", "", "", "New type created on import", "", "", ""],
  ["Example: Microsoft 365 Business", "Subscription", "", "", 10, "Microsoft", "", "", "", "Good", "", "", "", "Purchased", "2026-01-01", 2500, "", "", "", "EXP-2026-00012", "10 seats", "", "2027-01-01", "Delete or change this row: the expense number is an example"],
];

/** Builds the workbook. Lists reflect what is set up in the CRM right now. */
export function buildInventoryTemplate(lists: {
  types: { name: string; category: string; tracking: string }[];
  places: string[];
  staff: { fullName: string; email: string }[];
}): Buffer {
  const wb = XLSX.utils.book_new();

  const sheet = XLSX.utils.aoa_to_sheet([TEMPLATE_COLUMNS.map((c) => c.header), ...EXAMPLES]);
  sheet["!cols"] = TEMPLATE_COLUMNS.map((c) => ({ wch: c.width }));
  sheet["!freeze"] = { xSplit: 1, ySplit: 1 };
  sheet["!views"] = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
  sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: TEMPLATE_COLUMNS.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, sheet, "Inventory");

  const instructions = XLSX.utils.aoa_to_sheet([
    ["BabulTech CRM - inventory import"],
    [""],
    ["1. Fill the Inventory sheet: one row per item, or per stock line of a counted item (e.g. 30 bulbs in the Store room)."],
    ["2. Rows starting with \"Example:\" are skipped. Delete them or type over them."],
    ["3. Columns marked * are required. For things we have had for a while, a best-guess purchase date and cost are fine."],
    ["4. In the CRM: Finance > Inventory > Import. Upload the file; every row is checked and nothing is saved until all rows are clean."],
    ["5. Items given to a person are recorded as already received by them. Prices are never shown to them."],
    ["6. Money: existing items are recorded as Already had, with no expense. For something bought recently, put the Expense number to link it."],
    [""],
    ["Column", "What to put"],
    ...TEMPLATE_COLUMNS.map((c) => [c.header, c.help]),
  ]);
  instructions["!cols"] = [{ wch: 24 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(wb, instructions, "Instructions");

  const rows = Math.max(lists.types.length, lists.places.length, lists.staff.length, 4);
  const conditions = ["New", "Good", "Needs repair", "Broken"];
  const hows = ["Already had", "Gift", "Purchased"];
  const listAoa: (string | number)[][] = [["Type", "Category", "Tracked", "", "Place", "", "Condition", "How we got it", "", "Staff name", "Staff email"]];
  for (let i = 0; i < rows; i++) {
    const t = lists.types[i];
    const s = lists.staff[i];
    listAoa.push([
      t?.name ?? "", t?.category ?? "", t ? (t.tracking === "QUANTITY" ? "Counted" : "One by one") : "", "",
      lists.places[i] ?? "", "", conditions[i] ?? "", hows[i] ?? "", "", s?.fullName ?? "", s?.email ?? "",
    ]);
  }
  const listSheet = XLSX.utils.aoa_to_sheet(listAoa);
  listSheet["!cols"] = [{ wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 2 }, { wch: 20 }, { wch: 2 }, { wch: 13 }, { wch: 14 }, { wch: 2 }, { wch: 24 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, listSheet, "Lists");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
