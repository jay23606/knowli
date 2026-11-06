import { ingVerbsByRule, STATE_VERBS, type IngRule } from "../english/ing-forms";
import { TIME_MARKER_LISTS } from "./time-markers";

/**
 * Teksty tematu Present Continuous dopisywane do opisów jego reguł w katalogu gramatyki
 * (`rules.ts`), więc trafiają do księgi reguł agenta tylko w tym temacie (jak wskazówki
 * „to be”). Listy czasowników i wskaźników pochodzą ze stałych walidatora, więc prompt nie
 * rozjedzie się z regułami odrzucania; `PC_GUIDANCE` to dydaktyka, której kod nie sprawdza.
 */

const verbs = (...rules: IngRule[]): string => ingVerbsByRule(rules).join(", ");

/**
 * Lista wskaźników czasu dla modelu według składni wpisów `TIME_MARKER_LISTS`:
 * wykrzyknienia („Look!”) tylko na początku zdania, frazy z „…” tylko na
 * początku tekstu, „N” to liczebnik.
 */
function markerText(entries: readonly string[]): string {
  const exclamations = entries.filter((entry) => entry.endsWith("!"));
  const starts = entries.filter((entry) => entry.endsWith("…"));
  const phrases = entries
    .filter((entry) => !entry.endsWith("!") && !entry.endsWith("…"))
    .map((entry) => entry.replace(/^N /, "<number> "));
  const parts = [phrases.join(", ")];
  if (exclamations.length > 0) parts.push(`${exclamations.join(" ")} only at the start of a sentence`);
  if (starts.length > 0) parts.push(`${starts.map((entry) => `${entry}?`).join(" / ")} only at the start of the text`);
  return parts.join("; ");
}

/** Tabela czasowników według reguł pisowni (dopisek `grammar.pc_ing_rule_not_allowed`). */
export const PC_VERB_LISTS =
  ` Plain verbs (also in the brackets of a gap and in a present simple answer): ${verbs("plain")}. ` +
  `Drop the final e: ${verbs("drop_e")}. Double the last consonant: ${verbs("double")}. ie becomes y: ${verbs("ie_to_y")}. ` +
  `Never use ${verbs("other")}.`;

/** Kolokacje „having/looking” wypisane ręcznie — test modułu sprawdza, że reguła czasowników stanu je przepuszcza. */
export const PC_COLLOCATIONS =
  "having breakfast, having lunch, having dinner, having a bath, having a shower, having fun, having a party, looking at, looking for";

/** Czasowniki stanu i dozwolone kolokacje (dopisek `grammar.pc_state_verb_ing`, w celach porównania `grammar.pc_state_verb_tense_choice`). */
export const PC_STATE_VERB_LIST = ` State verbs: ${[...STATE_VERBS].join(", ")}. Allowed collocations: ${PC_COLLOCATIONS}.`;

/** Wskaźniki „teraz” (dopisek `grammar.pc_now_marker_missing`, w celach porównania `grammar.pc_tense_marker_missing`). */
export const PC_NOW_MARKERS =
  ` Now markers: ${markerText(TIME_MARKER_LISTS.nowEn)}; in Polish: ${markerText(TIME_MARKER_LISTS.nowPl)}. ` +
  "A Polish exclamation counts only with ! (Cicho! Dziadek śpi., never Cicho, dziadek śpi.).";

/** Wskaźniki „zwykle” (dopisek `grammar.pc_usually_marker`, w celach porównania `grammar.pc_tense_marker_missing`). */
export const PC_USUALLY_MARKERS =
  ` Usually markers: ${markerText(TIME_MARKER_LISTS.usuallyEn)}; in Polish: ${markerText(TIME_MARKER_LISTS.usuallyPl)}.`;

/** Wskaźniki zakazane (dopisek `grammar.pc_forbidden_marker`). */
export const PC_FORBIDDEN_MARKERS = ` Forbidden markers: ${TIME_MARKER_LISTS.forbidden.join(", ")}.`;

/**
 * Wzory wyjaśnienia `explanationPl` celów porównania cytowane we wskazówkach. Każdy musi być jednym
 * zdaniem (`explanationTextErrors`), inaczej skopiowane wyjaśnienie zostałoby odrzucone; scenka-wykrzyknienie
 * stoi w cudzysłowie, bo „!” przed cudzysłowem nie kończy zdania (`sentenceCount`).
 */
export const PC_EXPLANATION_EXAMPLE = "Every day mówi, że to zwykle, więc Ola reads.";
export const PC_EXPLANATION_SCENE_EXAMPLE = "„Cicho!” mówi, że dziadek śpi w tej chwili, więc Grandpa is sleeping.";

/**
 * Dydaktyka całego tematu (spec „Present Continuous” §2, §5.6, §7.2; kod jej nie sprawdza) w dopisku opisu
 * `grammar.pc_forbidden_marker`, reguły każdego celu. Angielskie zdania z nawiasów sprawdza test modułu
 * (przechodzą walidator albo mają go oblać).
 */
export const PC_GUIDANCE =
  " Teaching hints for the present_continuous topic: the child learns WHEN to use the tense, so every exercise makes the " +
  "time of the action clear with a marker or a scene. Polish often uses one verb for both (Ola czyta), so the marker or the " +
  "scene decides, never the Polish verb. " +
  "A short Polish scene in instructionPl is a good context: its own short sentence before the task (Cicho! Dziadek śpi. " +
  "Uzupełnij zdanie.); never use teraz, właśnie, zawsze or zwykle as words of the task " +
  "itself (never Teraz uzupełnij zdanie.), because there they are no marker. " +
  "A context sentence may use is or are without a verb (This is Ola., It is sunny.), but never a verb of the table as an " +
  "adjective after is (never The door is open.). " +
  "explanationPl is exactly one sentence: an exclamation or a question of the scene stands in quotes („Look!”, „Cicho!”, " +
  "„Gdzie jest tata?”), so it ends no sentence; it names only verb forms that stand in this exercise (is cooking for a " +
  "sentence with cooking, never another verb such as is reading). " +
  "The examples of the objective (shown to the child on its cards) follow the rules of its exercises, with the same markers. " +
  "Never copy an example from the objective's cards into an exercise: change at least the subject, the verb or the object. " +
  "Polish appears only in instructionPl, explanationPl and the lesson_open_answer prompt; stems, statements, options and answers " +
  "are in English (Polish names such as Ola are fine).";

/**
 * Tłumaczenia w celach form 1, 3, 4, 5 (§5.4) w dopisku opisu `grammar.pc_translation_now_marker`, reguły tylko tych
 * celów: goły „teraz” wystarcza w nich poza przeczeniem (standard „Środek”, `grammar.pc_now_marker_bare`).
 */
export const PC_FORMS_TRANSLATION_GUIDANCE =
  " A translation carries the Polish now marker into English (teraz → now, w tej chwili → at the moment, Patrz! → Look!; in a " +
  "negative never a bare teraz) and lists the other now markers the sentence allows as acceptedAnswers, never a variant " +
  "without a marker.";

/**
 * Dydaktyka celów porównania (§5.2, §5.5, §6.4) w dopisku opisu `grammar.pc_tense_marker_missing`,
 * reguły tylko tych celów; definiuje „tense-choice objectives” przy pierwszym użyciu.
 */
export const PC_TENSE_CHOICE_GUIDANCE =
  " Teaching hints for the tense-choice objectives (now_or_usually and now_or_usually_more): every exercise makes clear whether " +
  "the action is happening right now or happens usually, and the child infers the time from a situation, not from a marker " +
  "word. At least half of the lesson_gap, lesson_error_fix and gap lesson_choice exercises carry the time only in a short " +
  "Polish scene in instructionPl and have no English time marker in the stem or statement: now — Cicho! Dziadek śpi. " +
  "Wybierz dobrą formę. with the stem Grandpa ___ on the sofa.; usually — Tata codziennie myje auto. Popraw błąd w zdaniu. " +
  "with Dad is washing the car. → Dad washes the car.; other scenes: Gdzie jest tata? / Ola codziennie gra w piłkę. The " +
  "other exercises may put an English marker into the sentence (Look!, right now, every day); never write the refrain teraz " +
  "czy zwykle in an instruction, because it has markers of both groups. Their lesson_choice options are the same verb in the two tenses " +
  "(reads / is reading), and each stem is a different frame with its own object or place (Ola ___ a comic., Grandpa ___ on the sofa.). " +
  `explanationPl also names the marker or the scene (${PC_EXPLANATION_EXAMPLE} / ${PC_EXPLANATION_SCENE_EXAMPLE}). ` +
  "A translation carries the marker of its Polish sentence into English: a scene or a strong now marker (Patrz! → Look!, " +
  "w tej chwili → at the moment, never a bare teraz) or a usually marker (codziennie → every day), and lists the other now " +
  "markers the sentence allows as acceptedAnswers. " +
  "The examples of the objective are a pair with the same verb (Look! Ola is reading. / Ola reads comics every day.).";

/** Dydaktyka celu now_or_usually (§5.5) w dopisku opisu `grammar.pc_now_or_usually_question`, reguły tylko tego celu. */
export const PC_NOW_OR_USUALLY_GUIDANCE =
  " now_or_usually also checks meaning: a lesson_choice with options exactly now and usually, instructionPl exactly " +
  "Kiedy to się dzieje? and a stem without a marker (Ola is reading a comic. → now; Ola reads comics. → usually); a present " +
  "simple stem there has a general plural object (Ola reads comics., not Ola reads a comic.).";

/**
 * Dydaktyka celu now_or_usually_more (§6.3, §6.4) w dopisku opisu `grammar.pc_tense_choice_question_type`, reguły
 * tylko tego celu. Present Simple z „now” bywa poprawny („obecnie”), więc błąd w `error_fix` to Present Continuous
 * ze wskaźnikiem „zwykle” (ślepa ocena sondy).
 */
export const PC_NOW_OR_USUALLY_MORE_GUIDANCE =
  " In now_or_usually_more a choice between whole questions has instructionPl exactly Wybierz poprawne pytanie. (no time and " +
  "no scene in it), as its stem a short English context sentence without a gap about the same person or thing as the question " +
  "that fits the key's time and never suggests the other one (Ola is in a tennis club. → Does Ola play tennis on Mondays?), " +
  "and the time marker in both options. A lesson_error_fix there puts the present continuous into the statement and the " +
  "present simple into the answer, with the usually marker in the statement or in a Polish scene in instructionPl (Ola isn't " +
  "dancing on Fridays. → Ola doesn't dance on Fridays.), because the present simple with now is often correct English (nowadays).";
