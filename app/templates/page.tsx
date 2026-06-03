import type { Metadata } from "next";
import { Nav, Footer } from "@/components/landing-ref/Nav";
import { TemplatesBrowser } from "@/components/landing-ref/TemplatesBrowser";

export const metadata: Metadata = {
  title: "Templates — Floom Workers",
  description:
    "Browse ready-to-run AI workers by team, tool, trigger, and approval behavior. Choose a worker; Floom runs the work behind it.",
};

export default function TemplatesPage() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="px-6 py-16 sm:py-20">
        <div className="mx-auto max-w-6xl">
          <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
            Templates
          </div>
          <h1 className="text-balance text-[36px] font-semibold leading-tight tracking-[-0.025em] text-foreground sm:text-[46px]">
            Find a worker that already knows the job.
          </h1>
          <p className="mt-3 max-w-xl text-base text-muted-foreground">
            Browse ready-to-run workers by team, tool, trigger, and approval behavior.
          </p>
          <div className="mt-10">
            <TemplatesBrowser />
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
