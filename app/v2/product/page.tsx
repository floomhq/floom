import type { Metadata } from "next";
import { V2ProductBody } from "./V2ProductBody";

export const metadata: Metadata = {
  title: "Product · Workeros v2 preview",
  robots: { index: false, follow: false },
};

export default function V2ProductPage() {
  return <V2ProductBody />;
}
