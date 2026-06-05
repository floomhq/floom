import { HeroV1Cinematic } from "@/components/hero-variants/HeroV1Cinematic";
import { Nav } from "@/components/landing-ref/Nav";
import { VariantPicker } from "@/components/hero-variants/VariantPicker";

export const metadata = {
  title: "Workeros · Hero V1 (Cinematic)",
};

export default function V1Page() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <HeroV1Cinematic />
      <VariantPicker current="v1" />
    </div>
  );
}
