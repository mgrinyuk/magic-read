export function getActivityRpcArgs(mode, { userId, type, count, today }) {
  if (mode === "legacy") {
    return {
      p_user_id: userId,
      p_read: type === "words_read" ? count : 0,
      p_spoken: type === "words_spoken" ? count : 0,
      p_practiced: type === "words_practiced" ? count : 0,
      p_day: today
    };
  }

  return {
    p_user_id: userId,
    p_type: type,
    p_count: count,
    p_today: today
  };
}

// The day an activity counts toward: the user's local calendar day when the
// app sends one, so streaks follow the user's own midnight. Every real
// timezone is within one day of UTC, so anything further off (or malformed)
// is ignored in favour of the UTC date — a client can't back- or forward-date
// activity to fake a streak.
export function resolveActivityDay(clientDay, now = new Date()) {
  const utcDay = now.toISOString().slice(0, 10);
  if (typeof clientDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(clientDay)) return utcDay;

  const parsed = new Date(`${clientDay}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== clientDay) return utcDay;

  const diffDays = Math.round((parsed - new Date(`${utcDay}T00:00:00Z`)) / 86400000);
  return Math.abs(diffDays) <= 1 ? clientDay : utcDay;
}
