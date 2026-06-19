// Members page moved into Settings (Maintainer 2026-06-14).
// This redirect keeps old bookmarks and any deep-links working.
import { redirect } from "next/navigation";

export default function MembersRedirectPage() {
  redirect("/settings?sel=members");
}
