# Male Cyber Fighters — iOS app (iPhone / iPad)

The same native app as the Android build (v1.5.1), packaged with Capacitor
for iOS. It is **not** the website in a window — it bundles the native app
UI locally (`www/index.html`) and talks directly to the live MCF API +
Socket.IO, exactly like the Android app: login/register, Arena, Rooms, DMs,
Federations, Forums, Stories (including the story-from-DM builder),
Members, Profile, photo/clip sending and live audio calls.

## What is in this folder

- `www/index.html` — the v1.5 native app, identical to the Android build's UI.
- `capacitor.config.ts` — app ID `com.malecyberfighters.app`, local web app
  (no `server.url` — the app is bundled, not loaded from the site).
- `ios/` — the generated Xcode project (`ios/App/App.xcworkspace`), ready
  to open in Xcode. Bundle ID, icon and permissions are already set:
  microphone (audio calls), camera + photo library (sending photos/clips),
  background audio mode for calls. Minimum iOS 14.0 (audio calls need 14.3+).
- `resources/icon-1024.png` — App Store icon source.
- `.github/workflows/build-ios-native.yml` — GitHub Actions workflow that
  builds the IPA on a macOS runner.

## The honest limit: no signed IPA from a Linux box

iOS apps can only be compiled with Xcode on a Mac, and a real iPhone will
only install a signed app. This sandbox is Linux, so there is no IPA file
in this delivery — the project and the workflow are the deliverable, and
the IPA comes out of the macOS runner.

## Getting the IPA (free, no Apple Developer account)

1. Copy this whole `ios-app/` folder into the repo root.
2. Add `.github/workflows/build-ios-native.yml` to the repo.
3. Run the workflow manually from the Actions tab (or push a tag like
   `ios-v1.5.1` to publish a prerelease).
4. Download `CyberFights-ios.ipa` from the run's artifacts.

The IPA is unsigned. Install it on a real iPhone with AltStore (or
Sideloadly) using a free Apple ID — it re-signs the app with your Apple
ID. Free Apple IDs get a 7-day certificate, so the app needs refreshing
weekly through AltStore. The simulator zip in the same run is for testing
in the iOS Simulator on a Mac.

## TestFlight / App Store (paid route)

That needs the Apple Developer Program ($99/year), the App ID
`com.malecyberfighters.app` registered, a distribution certificate and a
provisioning profile stored as GitHub secrets, and the archive step run
with signing enabled instead of `CODE_SIGNING_ALLOWED=NO`. The app itself
is 18+ only, so expect App Store review to ask about content moderation
and reporting — the Android build's in-app Report button is part of this
same v1.5 UI.

## Local development (needs a Mac)

- `npm install` then `npx cap sync ios` and open `ios/App/App.xcworkspace`
  in Xcode to run on a simulator or a plugged-in iPhone.
- To update the app UI later, replace `www/index.html` with the newer
  native-app build, run `npx cap copy ios`, and bump the version in
  `package.json` (the workflow stamps 1.5.1 at archive time).
