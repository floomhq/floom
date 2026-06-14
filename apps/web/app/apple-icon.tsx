import { ImageResponse } from "next/og";

export const runtime = "edge";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// Apple touch icon — emerald squircle with the Floom brand mark
// (cream tag/arrow shape). Matches /icon.svg.
export default async function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#1a1a1a",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 40,
        }}
      >
        <svg
          width="120"
          height="120"
          viewBox="0 0 100 100"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z"
            fill="#FFFFFF"
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
