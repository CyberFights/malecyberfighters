import type { CapacitorConfig } from '@capacitor/cli';

// Male Cyber Fighters — iOS app (native app, v1.4).
//
// Unlike the repo's mobile/ Capacitor shell, which loads the live website,
// this app bundles the native app UI locally (www/index.html — the same
// app.html as the Android build) and talks directly to the live MCF API +
// Socket.IO, exactly like the Android app. No server.url: the app is local,
// every API/Socket.IO URL inside it is absolute https://.
const config: CapacitorConfig = {
  appId: 'com.malecyberfighters.app',
  appName: 'Male Cyber Fighters',
  webDir: 'www',
  ios: {
    contentInset: 'automatic'
  }
};

export default config;
