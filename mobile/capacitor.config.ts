import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.malecyberfighters.app',
  appName: 'Male Cyber Fighters',
  webDir: 'www',
  server: {
    // Keep the native apps on the same live site as the desktop app. This
    // means accounts, realtime sockets, rooms and DMs behave identically on
    // every client and fixes can be deployed without republishing a binary.
    url: 'https://malecyberfighters-production.up.railway.app/',
    cleartext: false,
    allowNavigation: ['malecyberfighters-production.up.railway.app']
  },
  ios: {
    contentInset: 'automatic'
  },
  android: {
    allowMixedContent: false
  }
};

export default config;
