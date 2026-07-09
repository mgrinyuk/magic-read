import Capacitor

class MyViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        // Set a Safari-like user agent so YouTube allows embedded playback.
        // WKWebView's default UA omits the Safari identifier, which causes
        // YouTube to detect a native app webview and block the embed.
        webView?.customUserAgent =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) " +
            "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
            "Version/17.4 Mobile/15E148 Safari/604.1"
    }
}
