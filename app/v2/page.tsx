import { HeroV2Editorial } from "@/components/hero-variants/HeroV2Editorial";
import { Nav } from "@/components/landing-ref/Nav";
import { VariantPicker } from "@/components/hero-variants/VariantPicker";

export const metadata = {
  title: "Workeros · Hero V2 (Editorial)",
};

export default function V2Page() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <HeroV2Editorial />
      <VariantPicker current="v2" />
    </div>
  );
}
