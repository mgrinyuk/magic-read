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
    },
    // Daily practice reminders. Android draws the status-bar icon from its alpha
    // channel only, so it needs this white silhouette (res/drawable); the
    // full-colour launcher icon would show up as a blank square.
    LocalNotifications: {
      smallIcon: 'ic_stat_magicread',
      iconColor: '#E5267E'
    }
  },
  ios: {
    // 'always' made WKWebView add its own status-bar inset on top of the
    // env(safe-area-inset-*) padding the CSS already applies under
    // viewport-fit=cover, leaving a dead band above the header. Let the CSS own
    // the insets — it also handles the home indicator and landscape correctly.
    contentInset: 'never'
  }
};

export default config;
