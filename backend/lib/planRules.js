const DAY_MS = 24 * 60 * 60 * 1000;

export function isLifetimeOfferEligible({
  enabled,
  plan,
  trialEndsAt,
  now = new Date(),
  windowDays = 7
}) {
  if (!enabled || plan === "pro" || !trialEndsAt || windowDays <= 0) return false;

  const trialEnd = new Date(trialEndsAt);
  const currentTime = new Date(now);
  if (Number.isNaN(trialEnd.getTime()) || Number.isNaN(currentTime.getTime())) return false;

  const elapsed = currentTime.getTime() - trialEnd.getTime();
  return elapsed >= 0 && elapsed <= windowDays * DAY_MS;
}

// Free users may open `limit` distinct texts a day; reopening a text already
// opened that day is free. Pro and trial users are never limited, but every
// new open is recorded. Keeps the last `maxKeys` keys for the day.
export function decideTextOpen({ isPro, used, openedKeys, textKey, limit, maxKeys = 50 }) {
  const keys = Array.isArray(openedKeys) ? openedKeys : [];
  if (textKey && keys.includes(textKey)) {
    return { allowed: true, record: false, used, openedKeys: keys };
  }
  if (!isPro && used >= limit) {
    return { allowed: false, record: false, used, openedKeys: keys };
  }
  return {
    allowed: true,
    record: true,
    used: used + 1,
    openedKeys: textKey ? [...keys, textKey].slice(-maxKeys) : keys
  };
}

// The app sends a hex hash of the text; anything else is ignored.
export function normalizeTextKey(value) {
  return typeof value === "string" && /^[a-f0-9]{16,64}$/.test(value) ? value : null;
}
