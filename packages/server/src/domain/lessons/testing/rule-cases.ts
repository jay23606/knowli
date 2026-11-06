import type { LessonRuleIssue } from "../rules/catalog";

/**
 * Rejestr przypadków reguł (spec katalogu reguł §2.4 pkt 3). Pliki
 * `*.rule-cases.ts` w obszarach rejestrują przypadki, a `rules/rule-cases.test.ts`
 * importuje je wszystkie i sprawdza kompletność katalogów.
 *
 * `violation` wywołuje prawdziwy walidator (nigdy fabrykę zgłoszeń wprost)
 * na danych łamiących regułę; `boundary` — na danych dokładnie na limicie
 * (`LessonRule.limit`), przy których reguła nie jest zgłaszana. Jedna reguła
 * może mieć kilka przypadków.
 */
export interface RuleCase {
  readonly rule: string;
  readonly violation: () => readonly LessonRuleIssue[];
  readonly boundary?: () => readonly LessonRuleIssue[];
}

const registered: RuleCase[] = [];

/** Dopisuje przypadki do rejestru (wołane przy imporcie pliku `*.rule-cases.ts`). */
export function registerRuleCases(cases: readonly RuleCase[]): void {
  registered.push(...cases);
}

/** Wszystkie zarejestrowane przypadki. */
export function allRuleCases(): readonly RuleCase[] {
  return [...registered];
}
