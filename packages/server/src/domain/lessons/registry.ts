import { validateSubject } from "./catalog-validation";
import type { LessonRule } from "./rules/catalog";
import type { LessonTopic, SubjectModule } from "./types";

/**
 * Rejestr przedmiotów (Registry): odczyt przedmiotów i tematów po id/wersji.
 * Bez globalnego stanu i efektów ubocznych importu — tworzony jawnie z listy
 * modułów. Odczyt nigdy nie rzuca: nieznane id/wersja → `undefined`.
 */
export interface SubjectRegistry {
  getSubject(id: string): SubjectModule | undefined;
  listSubjects(): readonly SubjectModule[];
  getTopic(subjectId: string, topicId: string, version: number): LessonTopic | undefined;
  getLatestTopic(subjectId: string, topicId: string): LessonTopic | undefined;
}

/**
 * Buduje rejestr z listy przedmiotów. Odrzuca (rzuca) duplikaty id przedmiotów,
 * przedmioty bez polityki agenta (`agentPolicy`; typ ją wymaga, kontrola
 * wykonawcza chroni moduły z JS i stuby) oraz moduły niepoprawne wg
 * `validateSubject`, dołączając listę błędów do komunikatu — walidacja katalogu
 * jest warunkiem rejestracji, nie odczytu. Odrzuca też id reguły powtórzone
 * w dwóch przedmiotach z różnymi obiektami wpisu (wspólny fragment katalogu,
 * np. angielski, daje ten sam obiekt i jest dozwolony).
 */
export function createSubjectRegistry(modules: SubjectModule[]): SubjectRegistry {
  const byId = new Map<string, SubjectModule>();
  const ruleOwners = new Map<string, { readonly subjectId: string; readonly rule: LessonRule }>();
  for (const module of modules) {
    if (byId.has(module.id)) {
      throw new Error(`Rejestr przedmiotów: zduplikowany identyfikator przedmiotu „${module.id}”`);
    }
    if ((module as { agentPolicy?: unknown }).agentPolicy === undefined) {
      throw new Error(`Rejestr przedmiotów: przedmiot „${module.id}” nie ma agentPolicy`);
    }
    const errors = validateSubject(module);
    if (errors.length > 0) {
      throw new Error(`Rejestr przedmiotów: przedmiot „${module.id}” niepoprawny:\n- ${errors.join("\n- ")}`);
    }
    for (const [ruleId, rule] of Object.entries(module.rules)) {
      const owner = ruleOwners.get(ruleId);
      if (owner === undefined) {
        ruleOwners.set(ruleId, { subjectId: module.id, rule });
      } else if (owner.rule !== rule) {
        throw new Error(
          `Rejestr przedmiotów: id reguły „${ruleId}” przedmiotu „${module.id}” koliduje z przedmiotem „${owner.subjectId}”`,
        );
      }
    }
    byId.set(module.id, module);
  }
  // Kolejność wstawienia zachowana — Map iteruje w kolejności dodania.
  const ordered: readonly SubjectModule[] = [...byId.values()];

  return {
    getSubject(id) {
      return byId.get(id);
    },
    listSubjects() {
      return ordered;
    },
    getTopic(subjectId, topicId, version) {
      return byId
        .get(subjectId)
        ?.topics.find((topic) => topic.id === topicId && topic.version === version);
    },
    getLatestTopic(subjectId, topicId) {
      const versions = byId.get(subjectId)?.topics.filter((topic) => topic.id === topicId);
      if (versions === undefined || versions.length === 0) {
        return undefined;
      }
      return versions.reduce((latest, topic) => (topic.version > latest.version ? topic : latest));
    },
  };
}
