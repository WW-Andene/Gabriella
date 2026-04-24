// app/manifest.webmanifest/route.js
//
// PWA manifest served at /manifest.webmanifest. Required by Bubblewrap
// (the tool that builds the Android APK from the deployed site) and by
// 'Add to Home Screen' flows on iOS + Chromium browsers.
//
// The manifest drives:
//   - Installed app name + shortname
//   - Launch URL (so the APK opens the chat page, not a random route)
//   - Display mode (standalone → no browser chrome, feels native)
//   - Theme + background color (matches the site's ambient dark amber)
//   - Icon URLs (dynamic PNG endpoints — no binary files in the repo)
//
// Keep this in sync with:
//   - twa-manifest.json at the repo root (Bubblewrap input)
//   - app/layout.js meta tags for theme-color + manifest link

export const runtime = "edge";

export async function GET() {
  const manifest = {
    name:             "Gabriella",
    short_name:       "Gabriella",
    description:      "A chat interface with memory, presence, and interiority.",
    start_url:        "/",
    scope:            "/",
    display:          "standalone",
    orientation:      "portrait",
    theme_color:      "#08080f",
    background_color: "#08080f",
    lang:             "en",
    dir:              "ltr",
    icons: [
      {
        src:     "/icon-192.png",
        sizes:   "192x192",
        type:    "image/png",
        purpose: "any maskable",
      },
      {
        src:     "/icon-512.png",
        sizes:   "512x512",
        type:    "image/png",
        purpose: "any maskable",
      },
    ],
    categories: ["social", "lifestyle", "productivity"],
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      "Content-Type":  "application/manifest+json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
