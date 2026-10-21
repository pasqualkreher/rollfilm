import type { RollSummary } from "../api/types";

// What a roll says beside its name: "12–14 Jul 2026 · X-T5". Short, for a
// card's second line, the page header and the contact sheet after an import.

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const DAY_NO_YEAR = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

export function rollSpanLabel(from: string | null | undefined, to: string | null | undefined): string {
  if (!from) return "";
  const a = new Date(from);
  const b = new Date(to ?? from);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return "";
  if (a.toDateString() === b.toDateString()) return DAY.format(a);
  if (a.getFullYear() === b.getFullYear()) return `${DAY_NO_YEAR.format(a)} – ${DAY.format(b)}`;
  return `${DAY.format(a)} – ${DAY.format(b)}`;
}

export function rollSubtitle(roll: RollSummary | null | undefined): string {
  if (!roll) return "";
  return [rollSpanLabel(roll.taken_from, roll.taken_to), roll.cameras.join(", ")].filter(Boolean).join(" · ");
}
