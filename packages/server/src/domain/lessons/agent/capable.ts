import type {
  AgentObjective,
  DynamicObjectiveKind,
  LessonTopic,
  SubjectAgentPolicy,
  SubjectModule,
} from "../types";

/** Przedmiot z polityką agenta puli — jedyny, który agent może generować. */
export type AgentCapableSubject = SubjectModule & { readonly agentPolicy: SubjectAgentPolicy };

/** Zwęża przedmiot do zdolnego do agenta; bez polityki to błąd (nie ma cichego obejścia). */
export function asAgentCapable(subject: SubjectModule): AgentCapableSubject {
  if (!subject.agentPolicy) throw new Error("subject has no agentPolicy");
  return subject as AgentCapableSubject;
}

/**
 * Zagadnienia tematu w widoku agenta: kolejność, karty i typy ćwiczeń z celów
 * tematu, rodzaj (`words`/`frame`) z mapy planu, gdy go zna.
 */
export function agentObjectivesOf(
  topic: LessonTopic,
  kinds?: ReadonlyMap<string, DynamicObjectiveKind>,
): AgentObjective[] {
  return topic.objectives.map((objective) => {
    const kind = kinds?.get(objective.id);
    return {
      id: objective.id,
      titlePl: objective.titlePl,
      descriptionEn: objective.descriptionEn,
      ...(kind ? { kind } : {}),
      cards: objective.cards.map((card) => ({ title: card.title, body: card.body })),
      exerciseTypes: objective.exerciseTypes,
    };
  });
}
