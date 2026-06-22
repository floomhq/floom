export const metadata = {
  title: "Terms | Floom",
  description: "Terms for using this Floom instance.",
};

export default function TermsPage() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Terms</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Last updated 2026-05-29.
        </p>
      </div>

      <div className="space-y-4 text-sm leading-relaxed">
        <p>
          Floom is source-available software provided as-is, without warranty of
          any kind. This instance is operated by its deployer for their own use.
        </p>

        <h2 className="text-base font-medium pt-2">Acceptable use</h2>
        <p>
          The account owner is responsible for the workers they run, the
          credentials they add, and the data those workers process. Do not use
          this instance to violate the terms of the model and tool providers it
          connects to (for example OpenAI, E2B, or Composio), or any applicable
          law.
        </p>

        <h2 className="text-base font-medium pt-2">Costs</h2>
        <p>
          Running workers and the workspace agent incurs costs with the
          configured providers (LLM tokens, sandbox time). The account owner is
          responsible for those costs. Per-user run and chat quotas exist to
          limit runaway spend, but they do not cap total spend.
        </p>

        <h2 className="text-base font-medium pt-2">Liability</h2>
        <p>
          To the maximum extent permitted by law, the software and its authors
          are not liable for any damages arising from use of this instance,
          including data loss, provider charges, or worker output.
        </p>

        <p className="text-muted-foreground pt-2">
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
