import type { Metadata } from "next";
import { V3Body } from "./V3Body";

export const metadata: Metadata = {
  title: "Workeros · v3 preview",
  description: "Landing preview, reduced.",
  robots: { index: false, follow: false },
};

export default function V3Page() {
  return <V3Body />;
}
