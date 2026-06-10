import type { Metadata } from "next";
import { V3TemplatesBody } from "./V3TemplatesBody";

export const metadata: Metadata = {
  title: "Templates · Workeros v3 preview",
  robots: { index: false, follow: false },
};

export default function V3TemplatesPage() {
  return <V3TemplatesBody />;
}
