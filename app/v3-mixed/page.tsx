import { HeroV3Mixed } from "@/components/hero-variants/HeroV3Mixed";
import { Nav } from "@/components/landing-ref/Nav";
import { VariantPicker } from "@/components/hero-variants/VariantPicker";

export const metadata = {
  title: "Workeros · Hero V3 Mixed",
};

export default function V3MixedPage() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <HeroV3Mixed />
      <VariantPicker current="v3-mixed" />
    </div>
  );
}
