/** A moment as a list shows it: the time today, the weekday this week, else the date. */
export function formatWhen(timestampMs: number, nowMs: number = Date.now()): string {
  const when = new Date(timestampMs);
  const now = new Date(nowMs);
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(when)) / 86_400_000);
  if (days <= 0) return when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return when.toLocaleDateString(undefined, { weekday: "long" });
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
