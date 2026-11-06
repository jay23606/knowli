import { clip, type LessonRuleIssue } from "./catalog";

/**
 * Powód odrzucenia albo nota dla modelu agenta (spec katalogu reguł §4.1):
 * `[<id reguły>] <pole>: <found>`, zawsze w jednym wierszu. Typ znakowany
 * powstaje wyłącznie w formaterach poniżej, więc powód zawsze nazywa regułę.
 */
export type RuleReason = string & { readonly __ruleReason: unique symbol };

/** Jeden wiersz bez skracania: nowe linie i tabulatory na spację (treść `found` przycina już `clip`). */
function oneLine(text: string): string {
  return clip(text, Number.POSITIVE_INFINITY, { quote: false });
}

/** `[<rule>] <field>: <found>` albo `[<rule>] <field>`, gdy zgłoszenie nie ma `found`. */
export function formatRuleReason(issue: LessonRuleIssue): RuleReason {
  const head = `[${issue.rule}] ${oneLine(issue.field)}`;
  return (issue.found === undefined ? head : `${head}: ${oneLine(issue.found)}`) as RuleReason;
}

/** Powód z ofiarą: dodanie kandydata odrzuciłoby w lekcji inne ćwiczenie (`victimLabel`, np. `exercise ex3`). */
export function formatVictimReason(victimLabel: string, issue: LessonRuleIssue): RuleReason {
  return `adding this exercise would make the lesson reject ${oneLine(victimLabel)}: ${formatRuleReason(issue)}` as RuleReason;
}
