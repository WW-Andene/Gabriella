// app/manifest.js
//
// Native Next.js App Router convention. Next.js serves this at
// /manifest.webmanifest automatically with Content-Type:
// application/manifest+json, AND auto-injects <link rel="manifest">
// into every page. Replaces the previous app/manifest.webmanifest/
// route.js, which was serving HTML on Vercel (likely a build-error
// fallback — folder names containing dots don't route reliably in
// App Router) and broke the Bubblewrap APK build.
//
// Keep fields in sync with twa-manifest.json at the repo root; the
// GitHub Actions workflow overrides twa-manifest.json's manifest URL
// at build time, but the PWA icon sizes / colors / scope should match.

export default function manifest() {
  return {
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
}
