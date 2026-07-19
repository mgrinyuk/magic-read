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
    // Android mismeasures the keyboard inset on some devices (MIUI especially),
    // leaving a dead grey band between the app and the keyboard. The Keyboard
    // plugin measures the real visible frame itself; resizeOnFullScreen enables
    // that workaround path.
    Keyboard: {
      resize: 'native',
      resizeOnFullScreen: true
    }
  },
  ios: {
    contentInset: 'always'
  }
};

export default config;
