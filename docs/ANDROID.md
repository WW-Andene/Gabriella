# Android APK

Gabriella ships as a PWA wrapped in a Trusted Web Activity (TWA). The APK
is a thin Android shell around the deployed site — no native code, no
separate codebase. It installs like a normal app, hides browser chrome,
and routes back to `gabriella.vercel.app` under the hood.

## Build in GitHub Actions

The workflow lives at `.github/workflows/build-apk.yml`. Three triggers:

- **Manual** — Actions tab → "Build APK" → Run workflow. Optional inputs:
  `host` (e.g. `gabriella.vercel.app`), `appVersionCode`, `appVersionName`.
- **Release** — publishing a GitHub release builds and attaches the APK
  to the release automatically.
- **Push to `main`** — smoke test when `twa-manifest.json` or the
  workflow itself changes.

Output: `gabriella-release.apk`, uploaded as a workflow artifact (30-day
retention) and attached to release assets when applicable.

## Build locally

```
scripts/build-apk.sh [host]
```

Default host is `gabriella.vercel.app`. Requires Node 18+, JDK 17, and
the Android SDK (platforms;android-33 + build-tools;33.0.2).

The script generates an ephemeral debug keystore on first run so the APK
is sideload-installable via `adb install gabriella-release.apk`.

## Play Store signing

For a production APK, store these in GitHub repo secrets (Actions picks
them up automatically):

- `KEYSTORE_BASE64` — your persistent keystore, base64-encoded
- `KEYSTORE_PASSWORD`
- `KEY_ALIAS`
- `KEY_PASSWORD`

With those set, the workflow signs the APK with your production key.

## How the PWA lines up

Bubblewrap reads three assets from the deployed host:

| Path                      | Served by                                |
| ------------------------- | ---------------------------------------- |
| `/manifest.webmanifest`   | `app/manifest.webmanifest/route.js`      |
| `/icon-192.png`           | `app/icon-192.png/route.js` (ImageResponse) |
| `/icon-512.png`           | `app/icon-512.png/route.js` (ImageResponse) |

No binary icon files live in the repo — the icons are rendered on the
fly by `next/og`. Updating the icon means editing the JSX in those two
route files and redeploying.

## Versioning

`appVersionCode` must increment for every Play Store upload. In the
workflow's manual trigger, leave it blank to use `GITHUB_RUN_NUMBER`
(monotonic per repo). Bumping `appVersionName` (0.7.0 → 0.7.1) is what
users see in the Play listing.
