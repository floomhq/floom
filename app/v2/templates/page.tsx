import type { Metadata } from "next";
import { V2TemplatesBody } from "./V2TemplatesBody";

export const metadata: Metadata = {
  title: "Templates · WorkerOS v2 preview",
  robots: { index: false, follow: false },
};

export default function V2TemplatesPage() {
  return <V2TemplatesBody />;
}
