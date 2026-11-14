import { NextResponse } from "next/server";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { supabaseAdmin } from "@/lib/supabase";
import { buildInventoryTemplate } from "@/lib/inventory-template";

/** The inventory import template, with today's types, places and staff on its Lists sheet. */
export async function GET() {
  let me;
  try { me = await requireUser(); } catch { return new NextResponse("Sign in first.", { status: 401 }); }
  if (!can(me, PERMISSIONS.ASSET_WRITE)) return new NextResponse("Your role cannot import inventory.", { status: 403 });

  const db = supabaseAdmin();
  const [types, categories, places, staff] = await Promise.all([
    db.from("asset_type").select("name, tracking, categoryId").eq("active", true).order("name"),
    db.from("asset_category").select("id, name"),
    db.from("asset_location").select("name").eq("active", true).order("name"),
    db.from("app_user").select("fullName, email, userType, partnerId").eq("status", "ACTIVE").is("deletedAt", null).order("fullName"),
  ]);
  const category = new Map((categories.data ?? []).map((c) => [c.id, c.name as string]));
  const file = buildInventoryTemplate({
    types: (types.data ?? []).map((t) => ({ name: t.name, tracking: t.tracking, category: category.get(t.categoryId) ?? "" })),
    places: (places.data ?? []).map((p) => p.name),
    staff: (staff.data ?? []).filter((u) => (!u.userType || u.userType === "INTERNAL") && !u.partnerId).map((u) => ({ fullName: u.fullName, email: u.email })),
  });

  return new NextResponse(new Uint8Array(file), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="inventory-import-template.xlsx"',
      "Cache-Control": "no-store",
    },
  });
}
