export const metadata = {
  title: "Terms | Floom",
  description: "Terms for using Floom.",
};

export default function TermsPage() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Terms</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Last updated 2026-07-01.
        </p>
      </div>

      <div className="space-y-4 text-sm leading-relaxed">
        <p>
          These terms apply when you use Floom Cloud, the Floom web app, CLI,
          MCP server, and hosted worker runtime. If you self-host the open-source
          Floom software, you are responsible for operating that deployment.
        </p>

        <h2 className="pt-2 text-base font-medium">Your account and workspaces</h2>
        <p>
          You are responsible for the workspaces you create, the credentials and
          connections you add, and the workers or agents you run. Keep your login
          sessions, API tokens, CLI tokens, and MCP client configs private. You
          may revoke tokens and connections from the product settings.
        </p>

        <h2 className="pt-2 text-base font-medium">Acceptable use</h2>
        <p>
          Do not use Floom to break the law, abuse third-party services, access
          data you do not have rights to use, send spam, evade platform limits,
          or violate the terms of model, sandbox, communication, or tool
          providers that Floom connects to.
        </p>

        <h2 className="pt-2 text-base font-medium">Workers and outputs</h2>
        <p>
          Floom can create and run automations that read connected data, call
          tools, generate files, send messages, or schedule future work when you
          configure them to do so. You are responsible for reviewing worker
          behavior, approving sensitive actions, and deciding whether outputs
          are accurate or appropriate for your use case.
        </p>

        <h2 className="pt-2 text-base font-medium">Costs and limits</h2>
        <p>
          Running workers and agents can consume model tokens, sandbox time,
          storage, and third-party provider quota. Floom may apply product
          limits, rate limits, spend controls, or safety pauses to protect the
          service and your workspace.
        </p>

        <h2 className="pt-2 text-base font-medium">Service changes</h2>
        <p>
          Floom may change, suspend, or discontinue features as the product
          evolves. Preview, beta, and generated-worker features may be less
          stable than core product surfaces.
        </p>

        <h2 className="pt-2 text-base font-medium">Liability</h2>
        <p>
          To the maximum extent permitted by law, Floom is provided without
          warranties and is not liable for indirect damages, lost data, provider
          charges, business interruption, or decisions made from worker output.
        </p>

        <p className="pt-2 text-muted-foreground">
          See also{" "}
          <a className="underline" href="/privacy">
            Privacy
          </a>
          .
        </p>
      </div>
    </div>
  );
}
