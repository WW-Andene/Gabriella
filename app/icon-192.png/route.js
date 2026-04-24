// app/icon-192.png/route.js
//
// 192x192 PNG icon rendered on the fly via next/og ImageResponse.
// No binary assets in the repo — the icon is a tiny JSX document
// rasterized at request time. Bubblewrap fetches this during APK
// builds and bundles the result into the Android app.
//
// Design language matches the chat UI: deep near-black with a warm
// ambient glow, stylized 'g' set in a serif for weight.

import { ImageResponse } from "next/og";

export const runtime = "edge";
export const contentType = "image/png";
export const size = { width: 192, height: 192 };

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
          fontSize:       130,
          fontWeight:     500,
          fontFamily:     "serif",
          letterSpacing:  "-0.05em",
          borderRadius:   40,
        }}
      >
        g
      </div>
    ),
    { ...size }
  );
}
