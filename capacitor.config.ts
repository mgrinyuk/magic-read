import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.magicread.app',
  appName: 'Magic Read',
  webDir: 'frontend',
  server: {
    hostname: 'localhost',
    iosScheme: 'https'
  },
  ios: {
    contentInset: 'always'
  }
};

export default config;
