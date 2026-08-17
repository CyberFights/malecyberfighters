import * as WebBrowser from 'expo-web-browser'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createClient, AsyncStorageAdapter } from '@blinkdotnew/sdk'

export const blink = createClient({
  projectId: process.env.EXPO_PUBLIC_BLINK_PROJECT_ID || 'male-cyberfight-mobile-t176aj9n',
  publishableKey: process.env.EXPO_PUBLIC_BLINK_PUBLISHABLE_KEY || 'blnk_pk_xFdZt5-JwPBuZ9-8Pr7JJmqZbu3b6XCJ',
  authRequired: false,
  auth: { mode: 'headless', webBrowser: WebBrowser },
  storage: new AsyncStorageAdapter(AsyncStorage),
})
