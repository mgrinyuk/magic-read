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
