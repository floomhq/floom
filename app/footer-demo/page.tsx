import { Nav } from "@/components/landing-ref/Nav";
import { FooterArtDynamic } from "@/components/hero-variants/FooterArt";
import { ArtPicker } from "@/components/hero-variants/ArtPicker";

export const metadata = {
  title: "Workeros · Footer art demo",
};

export const dynamic = "force-dynamic";

export default function FooterDemoPage() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main>
        {/* Spacer so the page has scroll context and the footer-art treatment
            shows up at the BOTTOM of a real page, not at the top. */}
        <div className="px-6 pt-20 pb-32">
          <div className="mx-auto max-w-2xl text-center">
            <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--emerald-dark)]">
              Demo
            </div>
            <h1 className="text-balance text-[32px] font-semibold leading-[1.05] tracking-[-0.025em] text-foreground sm:text-[44px]">
              Footer artwork demo.
            </h1>
            <p className="mx-auto mt-5 max-w-md text-[15px] text-muted-foreground">
              Scroll to see the painterly band wrapping the Final CTA and footer. Use the picker at
              the top to try every candidate as a footer.
            </p>
          </div>
        </div>

        {/* Heavy lorem-ish spacer to give the page real height */}
        <div aria-hidden="true" className="h-96" />
      </main>

      <FooterArtDynamic />
      <ArtPicker />
    </div>
  );
}
