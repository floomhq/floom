import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// Matches the brand mark in components/layout/sidebar.tsx:
// bg-[var(--solid)] = #1a1a1a, text-[var(--solid-fg)] = #fbfbfb
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#1a1a1a",
          color: "#fbfbfb",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 124,
          fontWeight: 700,
          borderRadius: 32,
        }}
      >
        F
      </div>
    ),
    { ...size }
  );
}
