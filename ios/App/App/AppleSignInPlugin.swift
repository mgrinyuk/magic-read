import Foundation
import Capacitor
import AuthenticationServices
import CryptoKit

/// Sign in with Apple, required by App Store Review guideline 4.8 because the
/// app also offers Google sign-in.
///
/// Returns Apple's identity token plus the raw nonce. The web layer hands both
/// to supabase.auth.signInWithIdToken, which verifies the token against Apple
/// and matches the nonce — so the token is never trusted on its own.
///
/// Registered by hand in MyViewController.capacitorDidLoad(); Capacitor only
/// auto-registers plugins that ship as packages.
@objc(AppleSignInPlugin)
public class AppleSignInPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppleSignInPlugin"
    public let jsName = "AppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?
    private var currentNonce: String?

    @objc func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 13.0, *) {
            call.resolve(["available": true])
        } else {
            call.resolve(["available": false])
        }
    }

    @objc func signIn(_ call: CAPPluginCall) {
        guard #available(iOS 13.0, *) else {
            call.reject("Sign in with Apple requires iOS 13 or later.")
            return
        }

        // Apple wants the nonce hashed; Supabase wants the raw value back so it
        // can check the token was minted for this exact request.
        let nonce = Self.randomNonce()
        currentNonce = nonce
        pendingCall = call

        DispatchQueue.main.async {
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.fullName, .email]
            request.nonce = Self.sha256(nonce)

            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    private static func randomNonce(length: Int = 32) -> String {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var result = ""
        var remaining = length
        while remaining > 0 {
            var random: UInt8 = 0
            let status = SecRandomCopyBytes(kSecRandomDefault, 1, &random)
            if status != errSecSuccess { continue }
            // Reject values that would bias the modulo, so every character is
            // equally likely.
            if random < (255 - (255 % UInt8(charset.count))) {
                result.append(charset[Int(random) % charset.count])
                remaining -= 1
            }
        }
        return result
    }

    private static func sha256(_ input: String) -> String {
        let digest = SHA256.hash(data: Data(input.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

@available(iOS 13.0, *)
extension AppleSignInPlugin: ASAuthorizationControllerDelegate {
    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let call = pendingCall else { return }
        pendingCall = nil

        guard
            let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let tokenData = credential.identityToken,
            let identityToken = String(data: tokenData, encoding: .utf8),
            let nonce = currentNonce
        else {
            call.reject("Apple did not return an identity token.")
            return
        }

        // Apple sends the name only on the very first authorization, so pass it
        // along when it's there and let the web layer decide what to store.
        var name = ""
        if let fullName = credential.fullName {
            name = [fullName.givenName, fullName.familyName]
                .compactMap { $0 }
                .joined(separator: " ")
        }

        call.resolve([
            "identityToken": identityToken,
            "nonce": nonce,
            "email": credential.email ?? "",
            "fullName": name
        ])
    }

    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithError error: Error) {
        guard let call = pendingCall else { return }
        pendingCall = nil

        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            call.reject("Sign in with Apple was canceled.", "USER_CANCELED")
            return
        }
        call.reject(error.localizedDescription)
    }
}

@available(iOS 13.0, *)
extension AppleSignInPlugin: ASAuthorizationControllerPresentationContextProviding {
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? UIWindow()
    }
}
