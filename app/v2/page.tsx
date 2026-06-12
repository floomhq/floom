import type { Metadata } from "next";
import { V2Body } from "./V2Body";

export const metadata: Metadata = {
  title: "WorkerOS · v2 preview",
  description: "Landing preview on the FINAL wireframe design system.",
  robots: { index: false, follow: false },
};

export default function V2Page() {
  return <V2Body />;
}
