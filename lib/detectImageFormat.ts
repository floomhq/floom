export function detectImageFormat(base64: string): { mime: string; ext: string } {
  if (base64.startsWith("data:")) {
    const match = base64.match(/^data:image\/(\w+)/);
    if (match) return { mime: `image/${match[1]}`, ext: match[1] === "jpeg" ? "jpg" : match[1] };
  }
  if (base64.startsWith("/9j/")) return { mime: "image/jpeg", ext: "jpg" };
  if (base64.startsWith("iVBOR")) return { mime: "image/png", ext: "png" };
  if (base64.startsWith("R0lGOD")) return { mime: "image/gif", ext: "gif" };
  if (base64.startsWith("UklGR")) return { mime: "image/webp", ext: "webp" };
  if (base64.startsWith("PHN2Zy")) return { mime: "image/svg+xml", ext: "svg" };
  return { mime: "image/png", ext: "png" };
}
