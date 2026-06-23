"use client";

export const dynamic = "force-dynamic";

import { CliAuthContent } from "@/app/cli-auth/page.engine";

export { CliAuthContent, cliAuthLoginRedirect } from "@/app/cli-auth/page.engine";

export default function CloudCliAuthPage() {
  return (
    <CliAuthContent
      endpointBase="/app/api/cli-auth"
      loginPath="/app/login"
      sessionCheckPath="/app/api/me"
      clientName="workeros-cli"
    />
  );
}
