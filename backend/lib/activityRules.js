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
