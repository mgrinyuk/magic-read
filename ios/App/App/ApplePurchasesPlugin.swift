import Foundation
import Capacitor
import StoreKit

/// StoreKit 2 bridge for Magic Read Pro subscriptions on iOS.
///
/// Mirrors the Android `PlayBilling` plugin: the app calls `purchase()` /
/// `restore()`, then hands the returned transaction id to the backend
/// (`/api/apple/verify-purchase`), which is the single source of truth for
/// entitlements (Supabase `profiles.plan / plan_provider / plan_ends_at`).
///
/// Capacitor 8 auto-discovers this plugin via `CAPBridgedPlugin` — no manual
/// registration in AppDelegate is required.
@objc(ApplePurchasesPlugin)
public class ApplePurchasesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ApplePurchasesPlugin"
    public let jsName = "ApplePurchases"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise)
    ]

    @objc func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 15.0, *) {
            call.resolve(["available": true])
        } else {
            call.resolve(["available": false])
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId"), !productId.isEmpty else {
            call.reject("Missing productId.")
            return
        }

        guard #available(iOS 15.0, *) else {
            call.reject("In-app purchases require iOS 15 or later.")
            return
        }

        Task {
            do {
                let products = try await Product.products(for: [productId])
                guard let product = products.first else {
                    call.reject("Product not found in the App Store.")
                    return
                }

                let result = try await product.purchase()
                switch result {
                case .success(let verification):
                    switch verification {
                    case .verified(let transaction):
                        let payload: [String: Any] = [
                            "transactionId": String(transaction.id),
                            "originalTransactionId": String(transaction.originalID),
                            "productId": transaction.productID
                        ]
                        // Finishing marks the transaction consumed once we've
                        // captured its id; the backend re-verifies with Apple.
                        await transaction.finish()
                        call.resolve(payload)
                    case .unverified(_, let error):
                        call.reject("Purchase could not be verified: \(error.localizedDescription)")
                    }
                case .userCancelled:
                    call.reject("Purchase canceled.", "USER_CANCELED")
                case .pending:
                    call.reject("Purchase is pending approval.", "PURCHASE_PENDING")
                @unknown default:
                    call.reject("Unknown purchase result.")
                }
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func restore(_ call: CAPPluginCall) {
        guard #available(iOS 15.0, *) else {
            call.resolve(["purchases": []])
            return
        }

        Task {
            // currentEntitlements reflects the device's active subscriptions
            // without prompting for App Store credentials, so it's safe to run
            // silently on app open. Each entry is re-verified server-side.
            var purchases: [[String: Any]] = []
            for await result in Transaction.currentEntitlements {
                if case .verified(let transaction) = result {
                    purchases.append([
                        "transactionId": String(transaction.id),
                        "originalTransactionId": String(transaction.originalID),
                        "productId": transaction.productID
                    ])
                }
            }
            call.resolve(["purchases": purchases])
        }
    }
}
