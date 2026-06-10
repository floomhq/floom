import type { Metadata } from "next";
import { V3ProductBody } from "./V3ProductBody";

export const metadata: Metadata = {
  title: "Product · Workeros v3 preview",
  robots: { index: false, follow: false },
};

export default function V3ProductPage() {
  return <V3ProductBody />;
}
