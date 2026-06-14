"use client";

export const dynamic = "force-dynamic";

import { CliAuthContent } from "@/app/cli-auth/page.engine";

export { CliAuthContent } from "@/app/cli-auth/page.engine";

export default function CloudCliAuthPage() {
  return (
    <CliAuthContent
      endpointBase="/app/api/cli-auth"
      clientName="workeros-cli"
    />
  );
}
