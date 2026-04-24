// app/icon-512.png/route.js
//
// 512x512 PNG icon rendered on the fly via next/og ImageResponse.
// Used by Android adaptive icons + high-DPI 'Add to Home Screen'
// install targets.

import { ImageResponse } from "next/og";

export const runtime = "edge";
export const contentType = "image/png";
export const size = { width: 512, height: 512 };

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width:          "100%",
          height:         "100%",
          display:        "flex",
          alignItems:     "center",
          justifyContent: "center",
          background: "radial-gradient(ellipse 100% 100% at 40% 60%, #3a1d0a 0%, #08080f 70%)",
          color:          "#ffb860",
          fontSize:       348,
          fontWeight:     500,
          fontFamily:     "serif",
          letterSpacing:  "-0.05em",
          borderRadius:   110,
        }}
      >
        g
      </div>
    ),
    { ...size }
  );
}
