import { HeroV3Marquee } from "@/components/hero-variants/HeroV3Marquee";
import { Nav } from "@/components/landing-ref/Nav";
import { VariantPicker } from "@/components/hero-variants/VariantPicker";

export const metadata = {
  title: "Workeros · Hero V3 Marquee",
};

export default function V3MarqueePage() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <HeroV3Marquee />
      <VariantPicker current="v3-marquee" />
    </div>
  );
}
