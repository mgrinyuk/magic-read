import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.magicread.app',
  appName: 'Magic Read',
  webDir: 'frontend',
  server: {
    hostname: 'localhost',
    iosScheme: 'https'
  },
  plugins: {
    // Android mismeasured the keyboard inset on some devices (MIUI especially),
    // leaving a dead grey band between the app and the keyboard. resize:'native'
    // resizes the whole WebView to the real visible frame, which fixes it.
    // (resizeOnFullScreen is deliberately NOT set — it forces the WebView behind
    // the status bar; edge-to-edge insets are handled in MainActivity instead.)
    Keyboard: {
      resize: 'native'
    }
  },
  ios: {
    contentInset: 'always'
  }
};

export default config;
