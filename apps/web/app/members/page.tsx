// V4 SPEC §2: /members is NOT a standalone page. Members live in Settings → Members.
// This redirect ensures any bookmarks / old links land at the right place.
import { redirect } from "next/navigation";

export default function MembersRedirect() {
  redirect("/settings#members");
}
