// Members page moved into Settings (Federico 2026-06-14).
// This redirect keeps old bookmarks and any deep-links working.
import { redirect } from "next/navigation";
import { appPath } from "@/lib/app-path";

export default function MembersRedirectPage() {
  redirect(appPath("/settings?sel=members"));
}
