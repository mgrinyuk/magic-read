// Apple In-App Purchase verification via the App Store Server API.
//
// Mirrors the Google Play flow: the iOS app sends a StoreKit transaction id,
// and the backend independently asks Apple for that subscription's status.
// Because the request is authenticated with our own signed JWT and the answer
// comes straight from Apple over TLS, we trust the returned signed payloads the
// same way the Google flow trusts androidpublisher responses — we decode the
// JWS payloads for their data without re-verifying the certificate chain.

import jwt from "jsonwebtoken";

const KEY_ID = process.env.APPLE_IAP_KEY_ID || "";
const ISSUER_ID = process.env.APPLE_IAP_ISSUER_ID || "";
// The .p8 key contents. Render stores multi-line secrets fine, but also accept
// a single-line value with escaped "\n" so either paste style works.
const PRIVATE_KEY = (process.env.APPLE_IAP_PRIVATE_KEY || "").replace(/\\n/g, "\n");
// iOS uses a distinct bundle id (com.magicread.app was already taken on Apple's
// global namespace); Android keeps com.magicread.app on Google Play.
const BUNDLE_ID = process.env.APPLE_BUNDLE_ID || "com.magicread.ios";

const PRODUCTS = {
  monthly: process.env.APPLE_IAP_PRODUCT_MONTHLY || "magic_read_pro_monthly",
  annual: process.env.APPLE_IAP_PRODUCT_ANNUAL || "magic_read_pro_annual"
};

export const APPLE_PRODUCT_TO_TIER = Object.fromEntries(
  Object.entries(PRODUCTS).map(([tier, productId]) => [productId, tier])
);

const HOSTS = {
  production: "https://api.storekit.itunes.apple.com",
  sandbox: "https://api.storekit-sandbox.itunes.apple.com"
};

// StoreKit subscription statuses (Get All Subscription Statuses).
// 1 = active, 2 = expired, 3 = billing retry, 4 = billing grace period,
// 5 = revoked. Treat active + grace period as entitled.
const ENTITLED_STATUSES = new Set([1, 4]);

export function isAppleIapReady() {
  return !!(KEY_ID && ISSUER_ID && PRIVATE_KEY && BUNDLE_ID);
}

// Short-lived ES256 token used to authenticate App Store Server API calls.
function makeApiToken() {
  return jwt.sign(
    { iss: ISSUER_ID, aud: "appstoreconnect-v1", bid: BUNDLE_ID },
    PRIVATE_KEY,
    {
      algorithm: "ES256",
      keyid: KEY_ID,
      expiresIn: "10m",
      header: { alg: "ES256", kid: KEY_ID, typ: "JWT" }
    }
  );
}

// The signed payloads are plain JWS with base64url segments; decode (no verify)
// because they arrived over an authenticated TLS call to Apple.
function decodeSigned(jws) {
  if (!jws) return {};
  try {
    return jwt.decode(jws) || {};
  } catch {
    return {};
  }
}

async function fetchSubscriptionStatuses(transactionId, env) {
  const url = `${HOSTS[env]}/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${makeApiToken()}` }
  });
  return res;
}

// Verify a StoreKit transaction against Apple and resolve it to our entitlement
// shape. Tries the configured environment first, then the other one, since a
// sandbox transaction 404s against production and vice-versa.
export async function verifyAppleTransaction(transactionId, expectedProductId = null) {
  const configured =
    process.env.APPLE_IAP_ENVIRONMENT === "sandbox" ? "sandbox" : "production";
  const order = configured === "production"
    ? ["production", "sandbox"]
    : ["sandbox", "production"];

  let lastError = "Apple subscription lookup failed.";
  for (const env of order) {
    const res = await fetchSubscriptionStatuses(transactionId, env);
    if (res.status === 404) {
      lastError = "Transaction not found at Apple.";
      continue;
    }
    if (!res.ok) {
      lastError = `Apple App Store Server API returned ${res.status}.`;
      continue;
    }

    const body = await res.json().catch(() => ({}));
    const groups = Array.isArray(body?.data) ? body.data : [];

    // Flatten every last-transaction across subscription groups, decode each,
    // then pick the one matching the product the app reported (falling back to
    // the first entitled one, then just the first).
    const candidates = [];
    for (const group of groups) {
      for (const last of group.lastTransactions || []) {
        const info = decodeSigned(last.signedTransactionInfo);
        candidates.push({ status: last.status, info });
      }
    }
    if (!candidates.length) {
      lastError = "Apple returned no transactions for this subscription.";
      continue;
    }

    let chosen =
      (expectedProductId &&
        candidates.find((c) => c.info.productId === expectedProductId)) ||
      candidates.find((c) => ENTITLED_STATUSES.has(c.status)) ||
      candidates[0];

    const expiresMs = Number(chosen.info.expiresDate) || null;
    const active =
      ENTITLED_STATUSES.has(chosen.status) && !!expiresMs && expiresMs > Date.now();

    return {
      environment: env,
      originalTransactionId:
        chosen.info.originalTransactionId || String(transactionId),
      productId: chosen.info.productId || expectedProductId || null,
      tier: APPLE_PRODUCT_TO_TIER[chosen.info.productId] || null,
      status: chosen.status,
      expiresDate: expiresMs ? new Date(expiresMs).toISOString() : null,
      active,
      raw: { status: chosen.status, info: chosen.info }
    };
  }

  throw new Error(lastError);
}
