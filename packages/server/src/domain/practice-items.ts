import { localDay } from "./local-date";
import type { HistoryEntry, VocabularySkill } from "./types";

export type PracticeHistoryRecord = {
  itemId: string;
  skill: VocabularySkill;
  skillVersionId: string;
  source: string;
  target: string;
  history: readonly HistoryEntry[];
};

export type PracticeItem = {
  itemId: string;
  source: string;
  target: string;
  skills: VocabularySkill[];
  lastDifficultyDate: string;
};

export function selectPracticeItems(input: {
  records: readonly PracticeHistoryRecord[];
  currentPolicyVersion: string;
  periodStart: string;
  generatedAt: string;
  dates: readonly string[];
  timezone: string;
}): { items: PracticeItem[]; truncated: boolean } {
  const periodStart = Date.parse(input.periodStart);
  const cutoff = Date.parse(input.generatedAt);
  const byItem = new Map<string, { source: string; target: string; skills: Map<VocabularySkill, string> }>();

  for (const record of input.records) {
    const eligible = record.history.filter((entry) => entry.policyVersion === input.currentPolicyVersion);
    const difficulties = eligible.filter((entry) => {
      const receivedAt = Date.parse(entry.receivedAt);
      const date = localDay(receivedAt, input.timezone);
      return receivedAt >= periodStart && receivedAt <= cutoff && input.dates.includes(date) &&
        (entry.outcome === "incorrect" || entry.reason === "dont_remember");
    });
    const difficulty = difficulties.at(-1);
    if (!difficulty) continue;
    const cleared = eligible.some((entry) => entry.outcome === "correct" && entry.independent &&
      Date.parse(entry.receivedAt) > Date.parse(difficulty.receivedAt));
    if (cleared) continue;

    const date = localDay(difficulty.receivedAt, input.timezone);
    const item = byItem.get(record.itemId) ?? { source: record.source, target: record.target, skills: new Map<VocabularySkill, string>() };
    item.skills.set(record.skill, date);
    byItem.set(record.itemId, item);
  }

  const items = [...byItem.entries()].map(([itemId, item]) => {
    const dates = [...item.skills.values()].sort();
    return {
      itemId, source: item.source, target: item.target,
      skills: [...item.skills.keys()].sort(), lastDifficultyDate: dates.at(-1)!,
    };
  }).sort((a, b) => b.lastDifficultyDate.localeCompare(a.lastDifficultyDate) || a.itemId.localeCompare(b.itemId));
  return { items: items.slice(0, 5), truncated: items.length > 5 };
}
