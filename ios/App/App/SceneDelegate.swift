import UIKit
import Capacitor

/// iOS 27 won't launch an app built with its SDK unless the app uses the UIScene
/// life cycle: UIKit traps in UIApplicationEvaluateRuntimeIssueForNoSceneLifecycle
/// Adoption before the first frame. App Review hit exactly that on 1.0.4 (14).
/// Capacitor 8 ships no scene delegate, so this one is ours.
///
/// The window and root view controller still come from Main.storyboard, named in
/// Info.plist's scene manifest. What moves here is URL handling: with scenes, iOS
/// hands opened URLs and universal links to the scene instead of the app
/// delegate. They're forwarded to Capacitor exactly as AppDelegate does, or
/// magicread://auth-callback and deck/assignment links would never reach
/// appUrlOpen.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        // A link that launched the app from cold arrives here, not through the
        // methods below. The web layer may not be listening yet, but Capacitor
        // keeps it as lastURL and App.getLaunchUrl() picks it up on startup.
        if let url = connectionOptions.urlContexts.first?.url {
            open(url)
        }
        if let activity = connectionOptions.userActivities.first {
            self.scene(scene, continue: activity)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            open(context.url)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity) { _ in }
    }

    private func open(_ url: URL) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
    }
}
