import { Nav } from "@/components/landing-ref/Nav";
import { HeroV3Collage } from "@/components/hero-variants/HeroV3Collage";

export const metadata = {
  title: "Workeros · Hero V3 (Collage)",
  description: "Tactile Collage hero variant for side-by-side comparison.",
};

export default function V3Page() {
  return (
    <>
      <Nav />
      <main>
        <HeroV3Collage />
      </main>
    </>
  );
}
