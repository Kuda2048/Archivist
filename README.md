# Archive Reader

A local-first Android app (Capacitor) for reading AI chat exports. Supports
**Claude** and **ChatGPT** `conversations.json` files, reconstructs edit
branches, stores everything in SQLite, and searches instantly with FTS5
full-text search. Nothing ever leaves your device.

**System requirement:** Android 9 Pie (API 28) or newer. Built against
SDK 35 (Android 15); the SDK levels are pinned in `android/variables.gradle`.

## Project layout

```
capacitor.config.json        Capacitor app config (id, name, webDir)
package.json                 Dependencies
www/
  index.html                 App shell
  css/app.css                Styling (your original dark theme)
  js/
    app.js                   UI: list, search, reader, markdown export
    db.js                    Storage layer: SQLite+FTS5 on device,
                             in-memory fallback for browser preview
    tree.js                  Shared edit-branch reconstruction
    importers/
      index.js               Registry + provider auto-detection
      claude.js              Claude export → normalized schema
      chatgpt.js             ChatGPT export → normalized schema
```

The key idea: every importer normalizes into one common schema
(`conversation` + `message(id, parent_id, role, text, created_at)`), and the
UI only ever reads that schema. Adding Gemini later = one new importer file
plus one line in `importers/index.js`.

## Quick preview (no Android needed)

Open `www/index.html` in any desktop browser and import an export file.
This runs the in-memory backend — data disappears on refresh, which is
expected. It's just for testing the UI and importers quickly.

## Building the Android app

One-time prerequisites:

1. Install [Node.js LTS](https://nodejs.org)
2. Install [Android Studio](https://developer.android.com/studio) and let it
   install the default SDK during first launch

Then, in this folder:

```bash
npm install
npx cap sync             # copies www/ + plugins into android/ (after every change)
npx cap open android     # opens Android Studio
```

The `android/` native project is committed to the repo with min SDK 28
(Android 9) and target/compile SDK 35 (Android 15) already set, so there is
no need to run `npx cap add android`.

In Android Studio: plug in your phone (with USB debugging on) or start an
emulator, then press the green ▶ Run button. That's your APK.

Day-to-day loop after editing anything in `www/`:

```bash
npx cap sync && npx cap open android   # then press Run again
```

## Getting the APK without Android Studio

Every push to `main` runs a GitHub Actions workflow that builds the debug
APK and publishes it two ways:

- **Easiest — Releases:** open the repo's **Releases** page and download
  `archivist-debug.apk` from the **Latest debug build** release. This is a
  raw APK — download it on your phone and tap it to install (allow
  installs from unknown sources when asked). No GitHub login needed.
- **Actions artifact:** Actions → Build APK → latest run → Artifacts →
  `archive-reader-debug`. Note this downloads as a **zip** (and requires
  being logged in): extract it and install the `app-debug.apk` inside —
  installing the zip itself fails with a "can't parse package" error.

You can also start a build manually from the Actions tab via
"Run workflow".

## Getting your exports onto the phone

- **Claude**: Settings → Privacy → Export data → email link → unzip →
  `conversations.json`
- **ChatGPT**: Settings → Data controls → Export data → same idea

Copy the file to the phone (Downloads works) and pick it with the app's
import button. You can select multiple files at once, and re-importing a
newer export cleanly replaces conversations it already has.

## Next steps (roughly in order of effort)

**"Open with…" from the share sheet.** Install the
[`send-intent`](https://www.npmjs.com/package/send-intent) plugin and add an
intent filter for `application/json` to
`android/app/src/main/AndroidManifest.xml` inside the main `<activity>`:

```xml
<intent-filter>
    <action android:name="android.intent.action.SEND" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="application/json" />
</intent-filter>
```

Then read the shared file in `app.js` on launch and feed it through
`ARImportRegistry.detectAndNormalize` exactly like the file picker does.

**Backups.** The whole library is one SQLite file. Either rely on Android
auto-backup, or add an "Export library" button that copies the DB file out
via the `@capacitor/filesystem` plugin.

**Widgets** need real native code (Kotlin + Glance). Save for v2 — by then
you'll have picked up enough Android from the steps above.

## Troubleshooting

- **`npx cap add android` fails** → run `npm install` first.
- **App builds but the library is empty after restart** → you're probably
  running `www/index.html` in a browser (in-memory mode). On the device it
  persists.
- **Gradle sync errors in Android Studio** → File → Sync Project with Gradle
  Files, and make sure Android Studio finished downloading the SDK.
