export const ART_CANDIDATES = {
  mj1: { src: "/hero-art/mj1.jpg", label: "Wheatfield, golden hour", style: "Cinematic photo" },
  mj2: { src: "/hero-art/mj2.jpg", label: "Emerald hills, dawn", style: "Digital matte painting" },
  mj3: { src: "/hero-art/mj3.jpg", label: "Aerial wheatfield, sunset", style: "Cinematic photo" },
  b1: { src: "/hero-art/b1-floating-badges.jpg", label: "Floating badges", style: "Imagen photo" },
  a: { src: "/hero-art/a-office-cinematic.jpg", label: "Cinematic office", style: "Imagen photo" },
  c: { src: "/hero-art/c-organic-landscape.jpg", label: "Emerald hills", style: "Imagen painterly" },
  vg1: { src: "/hero-art/vg1.jpg", label: "Starry Night Office", style: "Van Gogh" },
  vg2: { src: "/hero-art/vg2.jpg", label: "Wheatfield Workers", style: "Van Gogh" },
  vg3: { src: "/hero-art/vg3.jpg", label: "Cafe Terrace Coworking", style: "Van Gogh" },
  vg4: { src: "/hero-art/vg4.jpg", label: "Sunflowers Workspace", style: "Van Gogh" },
  vg5: { src: "/hero-art/vg5.jpg", label: "Self-Portrait Worker", style: "Van Gogh" },
  vg6: { src: "/hero-art/vg6.jpg", label: "Workers in Wheatfield", style: "Van Gogh" },
} as const;

export type ArtKey = keyof typeof ART_CANDIDATES;
