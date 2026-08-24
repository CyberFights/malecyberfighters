# Male Cyber Fighters mobile apps

This directory is the native app wrapper for iPhone/iPad and Android. It uses
[Capacitor](https://capacitorjs.com/) to open the same responsive web client as
the desktop Electron app, so it shares the production API, accounts, realtime
Socket.IO connection, arena, rooms, DMs and profile data.

## Important distribution notes

- The **PWA install** is available immediately from the website. On Android,
  use the browser's **Install app** option. On iPhone/iPad, use Safari's
  **Share → Add to Home Screen**. This does not require an app-store account.
- A Google Play listing requires a Google Play Console account and a signed
  Android App Bundle. The release workflow can produce a debug APK for device
  testing; configure a release keystore before publishing to Play.
- Apple does not allow an unsigned IPA to be downloaded and installed like an
  Android APK. An Apple Developer account, signing/provisioning, App Store
  Connect review, and either TestFlight or App Store distribution are required.
- Because this service contains adult-oriented content, Apple and Google may
  apply additional age-rating and content-policy review. Store approval is
  not guaranteed by the wrapper itself.

## Local setup

Requirements: Node 20+, Android Studio/JDK for Android, and macOS with Xcode
for iOS.

```bash
cd mobile
npm ci
npm run cap:add:android   # once, when android/ does not exist
npm run cap:add:ios       # once, on macOS, when ios/ does not exist
npm run cap:sync
npm run cap:open:android
npm run cap:open:ios
```

The native projects are intentionally generated rather than committed. This
keeps platform-generated files out of the web repository and makes the setup
repeatable in CI. `capacitor.config.ts` contains the production URL used by
both shells; change it only when the canonical site moves.

## CI artifacts

`.github/workflows/build-mobile.yml` builds an Android debug APK and an iOS
simulator app on a manual workflow run or a `mobile-v*` tag. These artifacts
are for testing. Add signing secrets and an App Store/Play release step before
turning them into public store releases.
