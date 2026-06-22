import type { Metadata } from "next";
import { V3AdminBody } from "@/app/v3/templates/admin/V3AdminBody";

export const metadata: Metadata = {
  title: "Moderation — Floom",
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <V3AdminBody />;
}
