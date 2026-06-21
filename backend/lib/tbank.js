import crypto from "node:crypto";

export const TBANK_PLANS = Object.freeze({
  monthly: { code: "m", amount: 60000, days: 30, description: "Magic Read Pro — 1 month" },
  annual: { code: "y", amount: 500000, days: 365, description: "Magic Read Pro — 1 year" }
});

const PLAN_BY_CODE = Object.freeze(
  Object.fromEntries(Object.entries(TBANK_PLANS).map(([name, plan]) => [plan.code, { ...plan, name }]))
);

function uuidToBase64Url(uuid) {
  const hex = String(uuid).replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/i.test(hex)) throw new Error("Invalid user id");
  return Buffer.from(hex, "hex").toString("base64url");
}

function base64UrlToUuid(value) {
  const hex = Buffer.from(value, "base64url").toString("hex");
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createTbankOrderId(userId, planName, timestamp = Date.now()) {
  const plan = TBANK_PLANS[planName];
  if (!plan) throw new Error("Invalid T-Bank plan");
  return `mr_${plan.code}_${uuidToBase64Url(userId)}_${Number(timestamp).toString(36)}`;
}

export function parseTbankOrderId(orderId) {
  const match = /^mr_([my])_([A-Za-z0-9_-]{22})_([a-z0-9]+)$/.exec(String(orderId || ""));
  if (!match) return null;
  const plan = PLAN_BY_CODE[match[1]];
  const userId = base64UrlToUuid(match[2]);
  if (!plan || !userId) return null;
  return { userId, planName: plan.name, plan };
}

export function createTbankToken(payload, password) {
  const values = { ...payload, Password: password };
  delete values.Token;

  const source = Object.keys(values)
    .sort()
    .filter(key => values[key] !== undefined && values[key] !== null && typeof values[key] !== "object")
    .map(key => String(values[key]))
    .join("");

  return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

export function verifyTbankToken(payload, password) {
  const received = String(payload?.Token || "").toLowerCase();
  const expected = createTbankToken(payload || {}, password);
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
