/** Localised relative due-date text from a whole-day difference (pure). Mirrors home/time.ts `dueText` thresholds. */
import type { TFunction } from "./translator";

export function relativeDue(days: number, t: TFunction): { text: string; overdue: boolean } {
  if (days < 0) return { text: t("due.overdue", { count: -days }), overdue: true };
  if (days === 0) return { text: t("due.today"), overdue: false };
  if (days === 1) return { text: t("due.tomorrow"), overdue: false };
  if (days < 14) return { text: t("due.inDays", { count: days }), overdue: false };
  if (days < 60) return { text: t("due.inWeeks", { count: Math.round(days / 7) }), overdue: false };
  if (days < 365) return { text: t("due.inMonths", { count: Math.round(days / 30) }), overdue: false };
  return { text: t("due.inYears", { count: Number((days / 365).toFixed(1)) }), overdue: false };
}
