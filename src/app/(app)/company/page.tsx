import { redirect } from "next/navigation";

/** Merged into the Company overview; old links and favourites still land there. */
export default function CompanyPage() {
  redirect("/overview?tab=profile");
}
