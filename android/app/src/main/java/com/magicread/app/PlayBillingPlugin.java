package com.magicread.app;

import androidx.annotation.NonNull;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

@CapacitorPlugin(name = "PlayBilling")
public class PlayBillingPlugin extends Plugin implements PurchasesUpdatedListener {
    private BillingClient billingClient;
    private PluginCall pendingPurchaseCall;

    @Override
    public void load() {
        billingClient = BillingClient.newBuilder(getContext())
            .setListener(this)
            .enablePendingPurchases(
                PendingPurchasesParams.newBuilder()
                    .enableOneTimeProducts()
                    .build()
            )
            .build();
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        ensureReady(call, () -> {
            JSObject result = new JSObject();
            result.put("available", true);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void purchase(PluginCall call) {
        String productId = call.getString("productId");
        if (productId == null || productId.trim().isEmpty()) {
            call.reject("Missing productId.");
            return;
        }

        ensureReady(call, () -> queryProduct(productId, call, productDetails -> {
            String offerToken = firstOfferToken(productDetails);
            if (offerToken == null) {
                call.reject("No subscription offer is available for this product.");
                return;
            }

            BillingFlowParams.ProductDetailsParams productParams =
                BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(productDetails)
                    .setOfferToken(offerToken)
                    .build();

            pendingPurchaseCall = call;
            BillingResult result = billingClient.launchBillingFlow(
                getActivity(),
                BillingFlowParams.newBuilder()
                    .setProductDetailsParamsList(Collections.singletonList(productParams))
                    .build()
            );

            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                pendingPurchaseCall = null;
                call.reject(result.getDebugMessage());
            }
        }));
    }

    @PluginMethod
    public void queryPurchases(PluginCall call) {
        ensureReady(call, () -> billingClient.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.SUBS)
                .build(),
            (billingResult, purchases) -> {
                if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    call.reject(billingResult.getDebugMessage());
                    return;
                }
                JSObject result = new JSObject();
                result.put("purchases", purchasesToArray(purchases));
                call.resolve(result);
            }
        ));
    }

    @Override
    public void onPurchasesUpdated(@NonNull BillingResult billingResult, List<Purchase> purchases) {
        if (pendingPurchaseCall == null) return;

        PluginCall call = pendingPurchaseCall;
        pendingPurchaseCall = null;

        int code = billingResult.getResponseCode();
        if (code == BillingClient.BillingResponseCode.USER_CANCELED) {
            call.reject("Purchase canceled.", "USER_CANCELED");
            return;
        }
        if (code != BillingClient.BillingResponseCode.OK || purchases == null || purchases.isEmpty()) {
            call.reject(billingResult.getDebugMessage());
            return;
        }

        Purchase purchase = purchases.get(0);
        acknowledgeIfNeeded(purchase);
        call.resolve(purchaseToObject(purchase));
    }

    private void ensureReady(PluginCall call, Runnable ready) {
        if (billingClient == null) {
            call.reject("Billing client is not initialized.");
            return;
        }
        if (billingClient.isReady()) {
            ready.run();
            return;
        }
        billingClient.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(@NonNull BillingResult billingResult) {
                if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    ready.run();
                } else {
                    call.reject(billingResult.getDebugMessage());
                }
            }

            @Override
            public void onBillingServiceDisconnected() {}
        });
    }

    private interface ProductCallback {
        void onProduct(ProductDetails productDetails);
    }

    private void queryProduct(String productId, PluginCall call, ProductCallback callback) {
        QueryProductDetailsParams.Product product =
            QueryProductDetailsParams.Product.newBuilder()
                .setProductId(productId)
                .setProductType(BillingClient.ProductType.SUBS)
                .build();

        billingClient.queryProductDetailsAsync(
            QueryProductDetailsParams.newBuilder()
                .setProductList(Collections.singletonList(product))
                .build(),
            (billingResult, productResult) -> {
                if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    call.reject(billingResult.getDebugMessage());
                    return;
                }
                List<ProductDetails> products = productResult.getProductDetailsList();
                if (products == null || products.isEmpty()) {
                    call.reject("Product not found in Google Play.");
                    return;
                }
                callback.onProduct(products.get(0));
            }
        );
    }

    private String firstOfferToken(ProductDetails productDetails) {
        List<ProductDetails.SubscriptionOfferDetails> offers = productDetails.getSubscriptionOfferDetails();
        if (offers == null || offers.isEmpty()) return null;
        return offers.get(0).getOfferToken();
    }

    private void acknowledgeIfNeeded(Purchase purchase) {
        if (purchase.isAcknowledged()) return;
        AcknowledgePurchaseParams params = AcknowledgePurchaseParams.newBuilder()
            .setPurchaseToken(purchase.getPurchaseToken())
            .build();
        billingClient.acknowledgePurchase(params, billingResult -> {});
    }

    private JSArray purchasesToArray(List<Purchase> purchases) {
        JSArray array = new JSArray();
        if (purchases == null) return array;
        for (Purchase purchase : purchases) {
            array.put(purchaseToObject(purchase));
        }
        return array;
    }

    private JSObject purchaseToObject(Purchase purchase) {
        JSObject object = new JSObject();
        object.put("purchaseToken", purchase.getPurchaseToken());
        object.put("orderId", purchase.getOrderId());
        object.put("packageName", purchase.getPackageName());
        object.put("purchaseTime", purchase.getPurchaseTime());
        object.put("purchaseState", purchase.getPurchaseState());
        object.put("isAcknowledged", purchase.isAcknowledged());
        object.put("productIds", new JSArray(new ArrayList<>(purchase.getProducts())));
        return object;
    }
}
