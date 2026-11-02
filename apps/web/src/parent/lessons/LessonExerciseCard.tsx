"use client";

import { memo, useEffect, useRef, type ReactNode } from "react";
import { ActionIcon, Alert, Button, Checkbox, Group, Menu, NativeSelect, Paper, Radio, Stack, Text, TextInput, Textarea } from "@mantine/core";
import { messages, type CalculationSpec, type LessonDraftDto, type LessonPromptAudioDto } from "@learning/contracts";
import { ParentIcon } from "../ParentIcon";
import AssignmentFields from "./AssignmentFields";
import ClozeFields from "./ClozeFields";
import PromptAudioControls, { VoiceToneSelect } from "./PromptAudioControls";
import { clozeWordsOf, filledClozeOf, keywordsAnswerOf, nextRequiredElementId, type EditableLessonExercise } from "./lesson-editor-state";

/** Typy z polem „Zdanie” (stem) w edycji. */
const STEM_LABEL_TYPES = new Set(["lesson_choice", "lesson_listen_choice", "lesson_gap"]);
const UNITS = ["cm", "m", "km"].map((unit) => ({ value: unit, label: unit }));

/** Treść i odpowiedź karty w podglądzie (bez pól edycji). */
export function exercisePreview(ex: EditableLessonExercise): { text: string; answer: string } {
  // Luki z bankiem: tekst z lukami i uzupełniony tekst do sprawdzenia (design szkoły §13.7).
  if (ex.exerciseType === "lesson_cloze") {
    return { text: ex.clozeText ?? "", answer: filledClozeOf(ex.clozeText ?? "", clozeWordsOf(ex)) };
  }
  const text = ex.stem || ex.statement || ex.prompt || ex.instructionPl;
  const option = ex.options?.find((candidate) => candidate.id === ex.correctOption)?.text;
  const answer = ex.exerciseType === "lesson_notice" ? ex.correctOption : option ?? ex.answer;
  return { text, answer };
}

export interface CalculationControls {
  /** Tekst wpisany w pole liczby (z przecinkiem), zanim stanie się liczbą. */
  input: (field: string) => string | undefined;
  status: "pending" | "ready" | "error";
  onChange: (calculation: CalculationSpec) => void;
  onNumber: (field: string, text: string) => void;
  onKind: (kind: CalculationSpec["kind"]) => void;
}

function Field({ wide, children }: { wide?: boolean; children: ReactNode }) {
  return <div className={wide ? "pp-lesson-field pp-lesson-wide" : "pp-lesson-field"}>{children}</div>;
}

/**
 * Karta ćwiczenia (szkic 6b, decyzja C): domyślnie podgląd — typ, treść,
 * poprawna odpowiedź; „Edytuj” pokazuje pola danego typu. Karta zmieniona
 * albo z błędem walidacji jest zawsze otwarta. Indeks w `data-testid` to
 * pozycja w `form.exercises` (mapowanie błędów 400), nie kolejność na ekranie.
 */
interface LessonExerciseCardProps {
  ex: EditableLessonExercise;
  index: number;
  editable: boolean;
  busy: boolean;
  open: boolean;
  changed: boolean;
  /** Zapisana wersja ćwiczenia ma audio — zmiana oznacza nowe media po zapisie. */
  hadAudio: boolean;
  errors: string[] | undefined;
  audio: { state: string; assetId: string | null } | null;
  /** Ton lektora z odczytu lekcji: przedmiot nagrywa pytania — pokazujemy „Ton lektora” (poza `lesson_calculation`). */
  voiceTones: LessonDraftDto["voiceTones"];
  /** Nagranie pytania zapisanej wersji; null, gdy brak albo ćwiczenie zmieniono od zapisu. */
  promptAudio: LessonPromptAudioDto | null;
  /** Nagranie zdania „Posłuchaj i wybierz” zapisanej wersji (tylko odczyt, bez „Nagraj ponownie”); null poza tym typem albo po zmianie ćwiczenia. */
  sentenceAudio: LessonPromptAudioDto | null;
  /** Wersja szkicu i zestaw potrzebne do „Nagraj ponownie”. */
  lessonDraftId: string;
  deckId: string;
  /** Zapisana rewizja ćwiczenia (cel „Nagraj ponownie”). */
  itemRevisionId: string;
  /** Edytor ma niezapisane zmiany — nagranie powstaje z zapisanego tekstu, więc „Nagraj ponownie” czeka na zapis. */
  audioLocked: boolean;
  calculation: CalculationControls | null;
  /** Stabilne funkcje edytora (wspólne dla wszystkich kart) — karta podaje swój klucz. */
  onToggle: (cardKey: string) => void;
  onMutate: (clientKey: string, patch: Partial<EditableLessonExercise>) => void;
  onRemove: (clientKey: string) => void;
  onPlay: (assetId: string) => void;
}

/**
 * Karta renderuje się ponownie tylko przy zmianie własnych danych: edytor
 * zmienia obiekt tylko edytowanego ćwiczenia, a funkcje są stabilne. Audio
 * porównujemy po polach (obiekt powstaje przy każdym renderze edytora);
 * karta rachunkowa ma sterowanie przeliczane na bieżąco, więc renderuje się zawsze.
 */
function sameCardProps(prev: LessonExerciseCardProps, next: LessonExerciseCardProps): boolean {
  if (prev.calculation !== null || next.calculation !== null) return false;
  if (prev.audio?.state !== next.audio?.state || prev.audio?.assetId !== next.audio?.assetId) return false;
  if (prev.promptAudio?.state !== next.promptAudio?.state || prev.promptAudio?.assetId !== next.promptAudio?.assetId
    || prev.promptAudio?.previousAssetId !== next.promptAudio?.previousAssetId) return false;
  if (prev.sentenceAudio?.state !== next.sentenceAudio?.state || prev.sentenceAudio?.assetId !== next.sentenceAudio?.assetId
    || prev.sentenceAudio?.previousAssetId !== next.sentenceAudio?.previousAssetId) return false;
  return (Object.keys(next) as (keyof LessonExerciseCardProps)[])
    .every((key) => key === "audio" || key === "promptAudio" || key === "sentenceAudio" || key === "calculation" || Object.is(prev[key], next[key]));
}

function LessonExerciseCard({
  ex,
  index,
  editable,
  busy,
  open,
  changed,
  hadAudio,
  errors,
  audio,
  voiceTones,
  promptAudio,
  sentenceAudio,
  lessonDraftId,
  deckId,
  itemRevisionId,
  audioLocked,
  calculation,
  onToggle,
  onMutate: mutate,
  onRemove,
  onPlay,
}: LessonExerciseCardProps) {
  const disabled = !editable || busy;
  const onMutate = (patch: Partial<EditableLessonExercise>) => mutate(ex.clientKey, patch);
  const number = String(index + 1);
  // „Edytuj” / „Zwiń” podmieniają zawartość karty — fokus idzie na pierwsze pole albo z powrotem na „Edytuj”
  const rootRef = useRef<HTMLElement>(null);
  const focusAfterToggle = useRef<"open" | "close" | null>(null);
  useEffect(() => {
    const target = focusAfterToggle.current;
    if (!target || (target === "open") !== open) return;
    focusAfterToggle.current = null;
    const selector = target === "open" ? "input:not([disabled]), textarea:not([disabled]), select:not([disabled])" : "[data-edit-toggle]";
    rootRef.current?.querySelector<HTMLElement>(selector)?.focus();
  }, [open]);
  const toggle = (target: "open" | "close") => {
    focusAfterToggle.current = target;
    onToggle(ex.id ?? ex.clientKey);
  };
  // odpowiedź wyliczana z pól typu (rachunek, słowa kluczowe, pary, grupy, luki) — rodzic jej nie wpisuje
  const derived = ["lesson_calculation", "lesson_keywords", "lesson_match", "lesson_group", "lesson_cloze"].includes(ex.exerciseType);
  const errId = `exercise-errors-${index}`;
  const described = errors ? { "aria-describedby": errId } : {};
  const forcedOpen = changed || errors !== undefined;
  const preview = exercisePreview(ex);
  const audioReady = audio?.state === "approved" && audio.assetId !== null;
  const isListen = ex.exerciseType === "lesson_listen_choice";
  // odsłuch zdania: gotowe nagranie albo — przy tworzeniu i błędzie — poprzednie ujęcie, jeśli jest
  const sentenceAssetId = sentenceAudio ? (sentenceAudio.state === "ready" ? sentenceAudio.assetId : sentenceAudio.assetId ?? sentenceAudio.previousAssetId) ?? null : null;
  const audioText = audio ? messages.decks.audioState[audio.state === "approved" ? "ready" : audio.state] ?? "" : "";

  return (
    <Paper ref={rootRef} component="article" withBorder radius="md" p="sm" className="pp-lesson-ex" data-error={errors ? "true" : undefined} data-testid={`exercise-${index}`}>
      <Group gap="xs" wrap="nowrap" className="pp-lesson-ex-head">
        <span className="pp-status-badge" data-tone="info" data-testid={`exercise-type-${index}`}>{messages.lessons.exerciseTypes[ex.exerciseType]}</span>
        <Text size="sm" className="pp-editor-muted pp-lesson-ex-num">
          {messages.lessons.exerciseNumber.replace("{n}", String(index + 1))}
          {open && editable ? ` · ${messages.lessons.exerciseEditing}` : ""}
        </Text>
        {audio && (
          <span className="pp-status-badge" data-tone={audioReady ? "success" : audio.state === "failed" ? "danger" : "neutral"} data-testid={`exercise-audio-state-${index}`}>
            {audioText}
          </span>
        )}
        {sentenceAudio && (
          <span className="pp-status-badge" data-tone={sentenceAudio.state === "ready" ? "success" : sentenceAudio.state === "failed" ? "danger" : "neutral"}
            data-testid={`exercise-sentence-audio-state-${index}`}>
            {messages.decks.audioState[sentenceAudio.state] ?? ""}
          </span>
        )}
        {(editable || audio || sentenceAudio) && (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" size={44} radius="md" aria-label={messages.lessons.exerciseActionsLabel.replace("{n}", number)} data-testid={`exercise-menu-${index}`}>
                <ParentIcon name="more-vertical" />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {audio && (
                <Menu.Item leftSection={<ParentIcon name="volume" />} data-testid={`exercise-play-${index}`} disabled={!audioReady}
                  onClick={() => audio.assetId && onPlay(audio.assetId)}>
                  {messages.decks.listen}
                </Menu.Item>
              )}
              {sentenceAudio && (
                <Menu.Item leftSection={<ParentIcon name="volume" />} data-testid={`exercise-sentence-play-${index}`} disabled={sentenceAssetId === null}
                  onClick={() => sentenceAssetId && onPlay(sentenceAssetId)}>
                  {messages.decks.listen}
                </Menu.Item>
              )}
              {editable && (
                <Menu.Item color="red" leftSection={<ParentIcon name="x" />} data-testid={`exercise-remove-${index}`} disabled={busy} onClick={() => onRemove(ex.clientKey)}>
                  {messages.lessons.removeExercise}
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>

      {isListen && (
        <div className="pp-lesson-listen-note">
          <Text size="sm" className="pp-editor-muted" data-testid={`exercise-listen-note-${index}`}>{messages.lessons.listenChoiceNote}</Text>
          {sentenceAudio?.state === "failed" && (
            <Text size="sm" c="red" role="status" data-testid={`exercise-sentence-audio-failed-${index}`}>{messages.lessons.listenChoiceAudioFailed}</Text>
          )}
        </div>
      )}

      {errors && (
        <Alert color="red" variant="light" id={errId} role="alert" data-testid={errId} mb="sm" icon={<ParentIcon name="alert-triangle" />}>
          <Text size="sm" fw={600}>{messages.lessons.exerciseErrorsTitle}</Text>
          <ul className="pp-sup-list">{errors.map((message, i) => <li key={i}><Text size="sm">{message}</Text></li>)}</ul>
        </Alert>
      )}

      {promptAudio && (
        <div className="pp-lesson-prompt-audio">
          <PromptAudioControls audio={promptAudio} target={{ kind: "prompt", itemRevisionId }} lessonDraftId={lessonDraftId} deckId={deckId}
            canRegenerate={editable} locked={busy || audioLocked} testId={`exercise-prompt-audio-${index}`} onPlay={onPlay}
            targetLabel={messages.lessons.exerciseNumber.replace("{n}", number)} />
        </div>
      )}

      {!open ? (
        <Group justify="space-between" align="flex-end" gap="xs" wrap="nowrap">
          <div className="pp-lesson-ex-preview">
            <Text size="sm">{preview.text}</Text>
            {preview.answer && <Text size="sm" fw={600} className="pp-lesson-ex-answer">✓ {preview.answer}</Text>}
          </div>
          <Button size="md" variant="subtle" data-testid={`exercise-edit-${index}`} data-edit-toggle aria-expanded="false" onClick={() => toggle("open")}
            aria-label={(editable ? messages.lessons.editExerciseLabel : messages.lessons.showExerciseLabel).replace("{n}", number)}>
            {editable ? messages.lessons.editExercise : messages.lessons.showExercise}
          </Button>
        </Group>
      ) : (
        <Stack gap="sm">
          <div className="pp-lesson-fields">
            {!isListen && (
              <Field wide>
                <TextInput size="md" label={messages.lessons.exerciseInstructionLabel} data-testid={`exercise-instruction-${index}`}
                  value={ex.instructionPl} disabled={disabled} {...described}
                  onChange={(e) => onMutate({ instructionPl: e.currentTarget.value })} />
              </Field>
            )}

            {voiceTones && ex.exerciseType !== "lesson_calculation" && !isListen && (
              <Field>
                <VoiceToneSelect value={ex.voiceTone} disabled={disabled} styleEnabled={voiceTones.styleEnabled} testId={`exercise-voice-tone-${index}`}
                  onChange={(voiceTone) => onMutate({ voiceTone })} />
              </Field>
            )}

            {ex.calculation && calculation && (
              <fieldset className="pp-lesson-fieldset pp-lesson-wide" disabled={disabled}>
                <legend>{messages.lessons.exerciseTypes.lesson_calculation}</legend>
                <div className="pp-lesson-fields">
                  <Field>
                    <NativeSelect size="md" label={messages.lessons.calculationKindLabel} data-testid={`calculation-kind-${index}`}
                      value={ex.calculation.kind} disabled={disabled}
                      data={Object.entries(messages.lessons.calculationKinds).map(([value, label]) => ({ value, label }))}
                      onChange={(e) => calculation.onKind(e.currentTarget.value as CalculationSpec["kind"])} />
                  </Field>
                  {Object.entries(ex.calculation.params).map(([field, value]) => (
                    <Field key={field}>
                      {field === "fromUnit" ? (
                        <NativeSelect size="md" label={messages.lessons.calculationParams[field]} data-testid={`calculation-${field}-${index}`}
                          value={String(value)} disabled={disabled} data={UNITS}
                          onChange={(e) => calculation.onChange({ ...ex.calculation!, params: { ...ex.calculation!.params, fromUnit: e.currentTarget.value } } as CalculationSpec)} />
                      ) : (
                        <TextInput size="md" label={messages.lessons.calculationParams[field]} data-testid={`calculation-${field}-${index}`} inputMode="decimal"
                          value={calculation.input(field) ?? String(value).replace(".", ",")} disabled={disabled}
                          onChange={(e) => calculation.onNumber(field, e.currentTarget.value)} />
                      )}
                    </Field>
                  ))}
                  <Field>
                    <NativeSelect size="md" label={messages.lessons.calculationUnit} data-testid={`calculation-unit-${index}`}
                      value={ex.calculation.unit} disabled={disabled} data={UNITS}
                      onChange={(e) => calculation.onChange({ ...ex.calculation!, unit: e.currentTarget.value as CalculationSpec["unit"] })} />
                  </Field>
                  <Field>
                    <TextInput size="md" label={messages.lessons.calculationTolerance} data-testid={`calculation-tolerance-${index}`} inputMode="decimal"
                      value={calculation.input("tolerance") ?? String(ex.calculation.tolerance ?? "").replace(".", ",")} disabled={disabled}
                      onChange={(e) => calculation.onNumber("tolerance", e.currentTarget.value)} />
                  </Field>
                  <Field>
                    <TextInput size="md" label={messages.lessons.calculationFamilyId} data-testid={`calculation-family-${index}`}
                      value={ex.calculation.templateFamilyId} disabled={disabled}
                      onChange={(e) => calculation.onChange({ ...ex.calculation!, templateFamilyId: e.currentTarget.value })} />
                  </Field>
                </div>
                <Text size="sm" mt="sm" data-testid={`calculation-prompt-${index}`}>{ex.prompt}</Text>
                <Text size="sm" role="status" className="pp-editor-muted" data-testid={`calculation-status-${index}`}>
                  {calculation.status === "pending" ? messages.lessons.calculationPending
                    : calculation.status === "ready" ? messages.lessons.calculationReady : messages.lessons.calculationInvalid}
                </Text>
              </fieldset>
            )}

            {ex.exerciseType === "lesson_choice" && (
              <Field>
                <NativeSelect size="md" label={messages.lessons.exerciseVisualLabel} data-testid={`exercise-visual-${index}`}
                  value={ex.visualSubject} disabled={disabled}
                  data={[{ value: "", label: messages.lessons.exerciseVisualNone }, ...Object.entries(messages.lessons.visualSubjects).map(([value, label]) => ({ value, label }))]}
                  onChange={(e) => onMutate({ visualSubject: e.currentTarget.value })} />
              </Field>
            )}
            {STEM_LABEL_TYPES.has(ex.exerciseType) && (
              <Field wide>
                <TextInput size="md" label={messages.lessons.exerciseStemLabel} data-testid={`exercise-stem-${index}`}
                  value={ex.stem} disabled={disabled} onChange={(e) => onMutate({ stem: e.currentTarget.value })} />
              </Field>
            )}
            {(ex.exerciseType === "lesson_error_fix" || ex.exerciseType === "lesson_transform") && (
              <Field wide>
                <TextInput size="md" label={messages.lessons.exerciseStatementLabel} data-testid={`exercise-statement-${index}`}
                  value={ex.statement} disabled={disabled} onChange={(e) => onMutate({ statement: e.currentTarget.value })} />
              </Field>
            )}
            {(ex.exerciseType === "lesson_open_answer" || ex.exerciseType === "lesson_short_answer") && (
              <Field wide>
                <TextInput size="md" label={messages.lessons.exercisePromptLabel} data-testid={`exercise-prompt-${index}`}
                  value={ex.prompt || (ex.exerciseType === "lesson_short_answer" ? ex.stem : "")} disabled={disabled}
                  onChange={(e) => onMutate({ prompt: e.currentTarget.value })} />
              </Field>
            )}

            {ex.exerciseType === "lesson_notice" ? (
              <Field>
                <Text size="sm" className="pp-editor-muted" data-testid={`exercise-notice-word-${index}`}>
                  {messages.lessons.exerciseNoticeWord}: {ex.correctOption}
                </Text>
              </Field>
            ) : (
              <Field>
                <TextInput size="md" label={messages.lessons.exerciseAnswerLabel} data-testid={`exercise-answer-${index}`}
                  value={ex.answer} disabled={disabled || derived} {...described}
                  onChange={(e) => onMutate({ answer: e.currentTarget.value })} />
              </Field>
            )}

            {ex.options && (
              <fieldset className="pp-lesson-fieldset pp-lesson-wide">
                <legend>{messages.lessons.exerciseCorrectOptionLabel}</legend>
                <Stack gap="xs">
                  {ex.options.map((opt, oi) => (
                    <Group key={opt.id} gap="sm" wrap="nowrap">
                      <Radio size="md" name={`correct-${index}`} data-testid={`exercise-correct-${index}-${opt.id}`}
                        aria-label={messages.lessons.correctOptionLabel.replace("{n}", String(oi + 1))}
                        checked={ex.correctOption === opt.id} disabled={disabled}
                        onChange={() => onMutate({ correctOption: opt.id })} />
                      <TextInput size="md" className="pp-editor-grow" data-testid={`exercise-option-${index}-${oi}`} value={opt.text} disabled={disabled}
                        aria-label={messages.lessons.exerciseOptionLabel.replace("{n}", String(oi + 1))}
                        onChange={(e) => {
                          const text = e.currentTarget.value;
                          onMutate({ options: ex.options!.map((o) => (o.id === opt.id ? { ...o, text } : o)) });
                        }} />
                    </Group>
                  ))}
                </Stack>
              </fieldset>
            )}

            {ex.items && (
              <fieldset className="pp-lesson-fieldset pp-lesson-wide">
                <legend>{messages.lessons.exerciseItemLabel.replace("{n}", "")}</legend>
                <Stack gap="xs">
                  {ex.items.map((item, ii) => (
                    <TextInput key={item.id} size="md" data-testid={`exercise-item-${index}-${ii}`} value={item.text} disabled={disabled}
                      aria-label={messages.lessons.exerciseItemLabel.replace("{n}", String(ii + 1))}
                      onChange={(e) => {
                        const text = e.currentTarget.value;
                        onMutate({ items: ex.items!.map((o) => (o.id === item.id ? { ...o, text } : o)) });
                      }} />
                  ))}
                </Stack>
              </fieldset>
            )}

            {(ex.exerciseType === "lesson_match" || ex.exerciseType === "lesson_group") && (
              <AssignmentFields exercise={ex} index={index} disabled={disabled} onChange={onMutate} />
            )}

            {ex.exerciseType === "lesson_cloze" && (
              <ClozeFields exercise={ex} index={index} disabled={disabled} onChange={onMutate} />
            )}

            {ex.exerciseType === "lesson_keywords" && ex.keywordOptions && (
              <fieldset className="pp-lesson-fieldset pp-lesson-wide" data-testid={`keywords-${index}`}>
                <legend>{messages.lessons.keywordsLegend}</legend>
                <Stack gap="xs">
                  {ex.keywordOptions.map((opt, oi) => {
                    const isKey = (ex.keyOptionIds ?? []).includes(opt.id);
                    return (
                      <Group key={opt.id} gap="sm" wrap="nowrap">
                        <Checkbox size="md" data-testid={`keyword-key-${index}-${opt.id}`} checked={isKey} disabled={disabled}
                          aria-label={`${messages.lessons.keywordOptionLabel.replace("{n}", String(oi + 1))}: ${messages.lessons.keywordKeyLabel}`}
                          onChange={() => {
                            const current = ex.keyOptionIds ?? [];
                            const keyOptionIds = isKey ? current.filter((id) => id !== opt.id) : [...current, opt.id];
                            onMutate({ keyOptionIds, answer: keywordsAnswerOf({ keywordOptions: ex.keywordOptions, keyOptionIds }) });
                          }} />
                        <TextInput size="md" className="pp-editor-grow" data-testid={`keyword-option-${index}-${oi}`} value={opt.text} disabled={disabled} maxLength={40}
                          aria-label={messages.lessons.keywordOptionLabel.replace("{n}", String(oi + 1))}
                          onChange={(e) => {
                            const text = e.currentTarget.value;
                            const keywordOptions = ex.keywordOptions!.map((o) => (o.id === opt.id ? { ...o, text } : o));
                            onMutate({ keywordOptions, answer: keywordsAnswerOf({ keywordOptions, keyOptionIds: ex.keyOptionIds }) });
                          }} />
                      </Group>
                    );
                  })}
                </Stack>
              </fieldset>
            )}

            <Field>
              <Textarea size="md" autosize minRows={1} label={messages.lessons.exerciseAcceptedLabel} data-testid={`exercise-accepted-${index}`}
                value={ex.acceptedText} disabled={disabled || derived} onChange={(e) => onMutate({ acceptedText: e.currentTarget.value })} />
            </Field>
            <Field>
              <TextInput size="md" label={messages.lessons.exerciseFocusLabel} data-testid={`exercise-focus-${index}`}
                value={ex.focusText} disabled={disabled || derived} onChange={(e) => onMutate({ focusText: e.currentTarget.value })} />
            </Field>

            {ex.familyId && (
              <Field>
                <Text size="sm" className="pp-editor-muted" data-testid={`exercise-family-${index}`}>
                  {messages.lessons.familyLabel.replace("{family}", ex.familyId)}
                </Text>
              </Field>
            )}
            {ex.exerciseType === "lesson_open_answer" && ex.questionType && (
              <Field>
                <NativeSelect size="md" label={messages.lessons.questionTypeLabel} data-testid={`exercise-qtype-${index}`}
                  value={ex.questionType} disabled={disabled}
                  data={Object.entries(messages.lessons.questionTypes).map(([value, label]) => ({ value, label }))}
                  onChange={(e) => onMutate({ questionType: e.currentTarget.value })} />
              </Field>
            )}
            {ex.exerciseType === "lesson_open_answer" && ex.expectedForm && (
              <Field>
                <NativeSelect size="md" label={messages.lessons.expectedFormLabel} data-testid={`exercise-form-${index}`}
                  value={ex.expectedForm} disabled={disabled}
                  data={Object.entries(messages.lessons.expectedForms).map(([value, label]) => ({ value, label }))}
                  onChange={(e) => onMutate({ expectedForm: e.currentTarget.value })} />
              </Field>
            )}
            {ex.requiredElements && (
              <fieldset className="pp-lesson-fieldset pp-lesson-wide">
                <legend>{messages.lessons.requiredElementsLabel}</legend>
                <Stack gap="xs">
                  {ex.requiredElements.map((el, ei) => (
                    <Group key={el.id} gap="xs">
                      <TextInput size="md" className="pp-lesson-grow" data-testid={`exercise-required-${index}-${ei}`} value={el.text} disabled={disabled}
                        aria-label={messages.lessons.requiredElementLabel.replace("{n}", String(ei + 1))}
                        onChange={(e) => {
                          const text = e.currentTarget.value;
                          onMutate({ requiredElements: ex.requiredElements!.map((o) => (o.id === el.id ? { ...o, text } : o)) });
                        }} />
                      {editable && ex.requiredElements!.length > 1 && (
                        <Button size="md" variant="subtle" color="red" data-testid={`exercise-required-remove-${index}-${ei}`} disabled={busy}
                          onClick={() => onMutate({ requiredElements: ex.requiredElements!.filter((o) => o.id !== el.id) })}>
                          {messages.lessons.removeRequiredElement}
                        </Button>
                      )}
                    </Group>
                  ))}
                  {editable && ex.requiredElements.length < 6 && (
                    <Button size="md" variant="light" className="pp-lesson-start" data-testid={`exercise-required-add-${index}`} disabled={busy}
                      onClick={() => onMutate({ requiredElements: [...ex.requiredElements!, { id: nextRequiredElementId(ex.requiredElements!), text: "" }] })}>
                      {messages.lessons.addRequiredElement}
                    </Button>
                  )}
                </Stack>
              </fieldset>
            )}
            {ex.supplementaryElements && (
              <Field wide>
                <Textarea size="md" autosize minRows={2} label={messages.lessons.supplementaryLabel} data-testid={`exercise-supplementary-${index}`}
                  value={ex.supplementaryElements.join("\n")} disabled={disabled}
                  onChange={(e) => onMutate({ supplementaryElements: e.currentTarget.value.split(/\r?\n/) })} />
              </Field>
            )}
            {ex.commonErrors && (
              <Field wide>
                <Textarea size="md" autosize minRows={2} label={messages.lessons.commonErrorsLabel} data-testid={`exercise-common-errors-${index}`}
                  value={ex.commonErrors.join("\n")} disabled={disabled}
                  onChange={(e) => onMutate({ commonErrors: e.currentTarget.value.split(/\r?\n/) })} />
              </Field>
            )}
            {ex.sourceRefs && (
              <fieldset className="pp-lesson-fieldset pp-lesson-wide" data-testid={`exercise-sources-${index}`}>
                <legend>{messages.lessons.sourceRefsLabel}</legend>
                <Stack gap="xs">
                  {ex.sourceRefs.map((ref, ri) => (
                    <Stack key={ri} gap={6}>
                      <Group gap="xs">
                        <TextInput size="md" className="pp-lesson-grow" data-testid={`exercise-source-${index}-${ri}`} value={ref.quote} disabled={disabled}
                          aria-label={messages.lessons.sourceRefQuoteLabel.replace("{n}", String(ri + 1))}
                          onChange={(e) => {
                            const quote = e.currentTarget.value;
                            onMutate({ sourceRefs: ex.sourceRefs!.map((r, rj) => (rj === ri ? { ...r, quote } : r)) });
                          }} />
                        {editable && ex.sourceRefs!.length > 1 && (
                          <Button size="md" variant="subtle" color="red" data-testid={`exercise-source-remove-${index}-${ri}`} disabled={busy}
                            onClick={() => onMutate({ sourceRefs: ex.sourceRefs!.filter((_, rj) => rj !== ri) })}>
                            {messages.lessons.removeSourceRef}
                          </Button>
                        )}
                      </Group>
                      <Checkbox size="md" label={messages.lessons.parentSourceLabel} data-testid={`exercise-source-parent-${index}-${ri}`}
                        checked={ref.parentAdded === true} disabled={disabled}
                        onChange={(e) => {
                          const checked = e.currentTarget.checked;
                          onMutate({ sourceRefs: ex.sourceRefs!.map((r, rj) => (rj === ri ? { quote: r.quote, ...(checked ? { parentAdded: true } : {}) } : r)) });
                        }} />
                    </Stack>
                  ))}
                  {editable && ex.sourceRefs.length < 3 && (
                    <Button size="md" variant="light" className="pp-lesson-start" data-testid={`exercise-source-add-${index}`} disabled={busy}
                      onClick={() => onMutate({ sourceRefs: [...ex.sourceRefs!, { quote: "", parentAdded: true }] })}>
                      {messages.lessons.addSourceRef}
                    </Button>
                  )}
                </Stack>
              </fieldset>
            )}
          </div>
          <Group justify="space-between" gap="xs">
            {changed ? <Text size="sm" className="pp-editor-bar-note">{hadAudio ? messages.decks.changedMediaAfterSave : messages.lessons.exerciseChanged}</Text> : <span />}
            {!forcedOpen && (
              <Button size="md" variant="subtle" data-testid={`exercise-collapse-${index}`} aria-expanded="true" onClick={() => toggle("close")}
                aria-label={messages.lessons.collapseExerciseLabel.replace("{n}", number)}>
                {messages.lessons.collapseExercise}
              </Button>
            )}
          </Group>
        </Stack>
      )}
    </Paper>
  );
}

export default memo(LessonExerciseCard, sameCardProps);
