// An omitted date selects the active roster immediately. Explicit dates preserve history.
export const ROSTER_EFFECTIVE_FROM = "2026-09-10";
export const ROSTER_TRANSFER_FROM = "2026-09-23";

export function rosterCollection(team, date) {
  if (!/^[ABC]$/.test(team) || (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    throw new Error("無效的歸程隊或名單日期");
  }
  if (date === undefined || date >= ROSTER_TRANSFER_FROM) return `students_${team}_20260923`;
  if (date >= ROSTER_EFFECTIVE_FROM) return `students_${team}_20260910`;
  return date >= "2026-09-09" ? `students_${team}_20260909` : `students_${team}`;
}
