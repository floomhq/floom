import { HeroV3Wall } from "@/components/hero-variants/HeroV3Wall";
import { Nav } from "@/components/landing-ref/Nav";
import { VariantPicker } from "@/components/hero-variants/VariantPicker";

export const metadata = {
  title: "Workeros · Hero V3 Wall",
};

export default function V3WallPage() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <HeroV3Wall />
      <VariantPicker current="v3-wall" />
    </div>
  );
}
