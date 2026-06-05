import { HeroV4Artwork } from "@/components/hero-variants/HeroV4Artwork";
import { Nav } from "@/components/landing-ref/Nav";
import { VariantPicker } from "@/components/hero-variants/VariantPicker";
import { ArtPicker } from "@/components/hero-variants/ArtPicker";

export const metadata = {
  title: "Workeros · Hero V4 (Art)",
};

export default function V4Page() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <HeroV4Artwork />
      <ArtPicker />
      <VariantPicker current="v4" />
    </div>
  );
}
