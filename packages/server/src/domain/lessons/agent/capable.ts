import type {
  AgentObjective,
  DynamicObjectiveKind,
  LessonTopic,
} from "../types";

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
