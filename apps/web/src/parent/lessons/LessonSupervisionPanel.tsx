"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Group, NativeSelect, Paper, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  messages,
  LessonMockTestReportDtoSchema,
  type ChildDto,
  type LessonVerdictDecision,
  type ObjectiveProgressDto,
} from "@learning/contracts";
import { callParent, errorMessage, parentClient } from "../api";
import { ParentIcon } from "../ParentIcon";
import { orpc } from "../query-client";
import "./lesson-panels.css";

type Tone = "success" | "warning" | "info" | "danger" | "neutral";

export const OBJECTIVE_STATUS_TONE: Record<string, Tone> = {
  not_assessed: "neutral",
  learning: "info",
  needs_confirmation: "warning",
  needs_reconfirmation: "warning",
  mastered: "success",
};

export const VERDICT_TONE: Record<string, Tone> = { correct: "success", almost: "warning", incorrect: "danger" };

type VerdictAction = { verdictId: string } & ({ kind: "decision"; decision: LessonVerdictDecision } | { kind: "variant" });

/** Stała funkcja `select`: unia raportów (słówka vs lekcja) zwężana do raportów lekcji. */
const parseLessonReports = (result: { body: unknown }) => LessonMockTestReportDtoSchema.array().parse(result.body);

const formatDate = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString("pl-PL") : "—");

function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  // funkcja zamiany: teksty z materiału rodzica mogą zawierać „$”
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

function SchoolProgress({ objective }: { objective: ObjectiveProgressDto }) {
  const school = objective.school!;
  return (
    <div data-testid={`school-progress-${objective.objectiveId}`}>
      <Title order={5} className="pp-sup-subtitle">{messages.lessons.schoolKnowledgeTitle}</Title>
      <Text size="sm" className="pp-editor-muted">{fill(messages.lessons.schoolCounts, school.knowledge)}</Text>
      {school.byInputMethod && (
        <div data-testid={`school-input-method-${objective.objectiveId}`}>
          <Text size="sm" className="pp-editor-muted">{fill(messages.lessons.schoolInputKeyboard, school.byInputMethod.keyboard)}</Text>
          <Text size="sm" className="pp-editor-muted">{fill(messages.lessons.schoolInputSpeech, school.byInputMethod.speech)}</Text>
        </div>
      )}
      <Title order={5} className="pp-sup-subtitle">{messages.lessons.schoolPrecisionTitle}</Title>
      <Text size="sm" className="pp-editor-muted">{fill(messages.lessons.schoolPrecisionCounts, school.precision)}</Text>
      {school.fragmentKinds && (
        <Text size="sm" className="pp-editor-muted" data-testid={`school-fragment-kinds-${objective.objectiveId}`}>
          {fill(messages.lessons.schoolFragmentKinds, school.fragmentKinds)}
        </Text>
      )}
      {school.topConfusions && school.topConfusions.length > 0 && (
        <div data-testid={`school-confusions-${objective.objectiveId}`}>
          <Title order={5} className="pp-sup-subtitle">{messages.lessons.schoolConfusionsTitle}</Title>
          <ul className="pp-sup-list">
            {school.topConfusions.map((pair) => (
              <li key={`${pair.said}|${pair.meant}`}>
                <Text size="sm" span>{fill(messages.lessons.schoolConfusion, pair)}</Text> <Text size="sm" span className="pp-editor-muted">({pair.count})</Text>
              </li>
            ))}
          </ul>
        </div>
      )}
      {school.topMissing.length > 0 && (
        <>
          <Title order={5} className="pp-sup-subtitle">{messages.lessons.schoolMissingTitle}</Title>
          <ul className="pp-sup-list">
            {school.topMissing.map((m) => (
              <li key={m.text}><Text size="sm" span>{m.text}</Text> <Text size="sm" span className="pp-editor-muted">({m.count})</Text></li>
            ))}
          </ul>
        </>
      )}
      {school.recentAnswers.length > 0 && (
        <>
          <Title order={5} className="pp-sup-subtitle">{messages.lessons.schoolRecentTitle}</Title>
          <ul className="pp-sup-list">
            {school.recentAnswers.map((a, i) => (
              <li key={i}>
                <Text size="sm" className="pp-editor-muted">
                  <em>{a.text}</em> — {messages.lessons.schoolKnowledgeValue[a.knowledge] ?? a.knowledge}
                  {a.precision ? ` · ${messages.lessons.schoolPrecisionValue[a.precision] ?? a.precision}` : ""}
                  {a.inputMethod === "speech" ? ` · ${messages.lessons.schoolSpokenMarker}` : ""}
                </Text>
              </li>
            ))}
          </ul>
        </>
      )}
      {school.shortening && (
        <div data-testid={`supervision-shortening-${objective.objectiveId}`}>
          <Title order={5} className="pp-sup-subtitle">{messages.lessons.schoolShorteningTitle}</Title>
          <Text size="sm">{fill(messages.lessons.schoolShorteningCounts, { offered: school.shortening.offered, attempted: school.shortening.attempted, successful: school.shortening.successful })}</Text>
          <ul className="pp-sup-list">
            {school.shortening.recent.map((pair, i) => (
              <li key={i}>
                <Text size="sm" className="pp-editor-muted">
                  <em>{pair.original}</em> → <em>{pair.revision}</em>
                  {" — "}{pair.successful ? messages.lessons.schoolShorteningSuccess : messages.lessons.schoolShorteningNotYet}
                  {pair.lostElements.length > 0 && ` · ${fill(messages.lessons.schoolShorteningLost, { elements: pair.lostElements.join(", ") })}`}
                </Text>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ObjectiveCard({ objective, onRegenerate }: { objective: ObjectiveProgressDto; onRegenerate?: (objectiveId: string) => void }) {
  const id = objective.objectiveId;
  return (
    <Paper component="article" withBorder radius="md" p="md" className="pp-sup-card" data-testid={`progress-${id}`}>
      <Stack gap={6}>
        <Group justify="space-between" align="flex-start" gap="xs" wrap="nowrap">
          <Title order={4} fz="md" className="pp-editor-grow">{objective.titlePl}</Title>
          <span className="pp-status-badge" data-tone={OBJECTIVE_STATUS_TONE[objective.status] ?? "neutral"} data-testid={`progress-status-${id}`}>
            {messages.lessons.objectiveStatus[objective.status] ?? objective.status}
          </span>
        </Group>
        <Text size="sm" className="pp-editor-muted">
          {fill(messages.lessons.lastIndependentAt, { date: formatDate(objective.lastIndependentAt) })}
          {" · "}
          {fill(messages.lessons.nextReviewAt, { date: formatDate(objective.nextReviewAt) })}
        </Text>
        {objective.poolExhausted && (
          <Alert color="blue" variant="light" role="status" data-testid={`pool-exhausted-${id}`} icon={<ParentIcon name="info" />}>
            <Stack gap="xs" align="flex-start">
              <Text size="sm">{messages.lessons.poolExhausted}</Text>
              {onRegenerate && (
                <Button size="md" variant="light" data-testid={`pool-regen-${id}`} leftSection={<ParentIcon name="refresh" />}
                  onClick={() => onRegenerate(id)}>
                  {messages.lessons.poolExhaustedAction}
                </Button>
              )}
            </Stack>
          </Alert>
        )}
        {objective.school && <SchoolProgress objective={objective} />}
        {objective.topErrors.length === 0 ? (
          <Text size="sm" className="pp-editor-muted">{messages.lessons.noErrors}</Text>
        ) : (
          <div>
            <Title order={5} className="pp-sup-subtitle">{messages.lessons.topErrorsTitle}</Title>
            <ul className="pp-sup-list">
              {objective.topErrors.map((err) => (
                <li key={err.category} data-testid={`error-${id}-${err.category}`}>
                  <Text size="sm" span>{err.labelPl}</Text>{" "}
                  <Text size="sm" span className="pp-editor-muted">({fill(messages.lessons.errorCount, { n: err.count })})</Text>
                  {err.examples.length > 0 && (
                    <>
                      <Text size="sm" span className="pp-editor-muted"> — {messages.lessons.errorExamplesLabel}</Text>
                      <ul className="pp-sup-list">
                        {err.examples.map((ex, i) => (
                          <li key={i}><Text size="sm" span className="pp-editor-muted"><em>{ex}</em></Text></li>
                        ))}
                      </ul>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Stack>
    </Paper>
  );
}

/**
 * Panel nadzoru rodzica nad lekcją (zadanie 16): postęp celów wybranego
 * dziecka (statusy, kategorie błędów z przykładami TYLKO tego dziecka,
 * wyczerpana pula), próbne kartkówki lekcji oraz werdykty modelu z decyzjami
 * rodzica (potwierdź, uznaj za poprawne/błędne, dodaj jako wariant).
 * Odczyty przez zapytania kluczowane dzieckiem — spóźniona odpowiedź dla
 * poprzednio wybranego dziecka nie nadpisze bieżącego widoku; decyzja
 * odświeża listę werdyktów.
 */
export default function LessonSupervisionPanel({
  deckId,
  childrenList,
  gradingModel,
  onRegenerate,
}: {
  deckId: string;
  childrenList: ChildDto[];
  /** Nazwa modelu oceniającego (gdy dostępny) — do tekstu o providerze. */
  gradingModel: string | null;
  /** Dogenerowanie ćwiczeń dla celu z wyczerpaną pulą (reużywa akcji edytora). */
  onRegenerate?: (objectiveId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [childId, setChildId] = useState<string | null>(childrenList[0]?.id ?? null);
  const [notice, setNotice] = useState<string | null>(null);

  // Gdy lista dzieci dociera po zamontowaniu, wybierz pierwsze (jeśli żadne nie wybrane).
  useEffect(() => {
    if (childId === null && childrenList.length > 0) setChildId(childrenList[0]!.id);
  }, [childrenList, childId]);

  const progressQuery = useQuery({
    // własny klucz: pamięć trzyma samo `body`, nie wynik procedury oRPC
    queryKey: ["parent", "lessonProgress", deckId, childId],
    // bez sygnału anulowania (jak dawny odczyt): klucz z dzieckiem i tak odrzuca spóźnioną odpowiedź
    queryFn: () => callParent(() => parentClient.lessons.progress({ deckId, childId: childId! })).then((result) => result.body),
    enabled: childId !== null,
    // postęp dziecka zawsze świeży: po powrocie do dziecka nie pokazujemy starej odpowiedzi
    gcTime: 0,
  });
  const verdictsKey = orpc.lessons.verdicts.queryKey({ input: { deckId } });
  const verdictsQuery = useQuery({
    ...orpc.lessons.verdicts.queryOptions({ input: { deckId } }),
    select: (result) => result.body,
  });
  const mockQuery = useQuery({
    ...orpc.mockTests.list.queryOptions({ input: { childId: childId ?? "", deckId } }),
    select: parseLessonReports,
    enabled: childId !== null,
  });

  const verdictAction = useMutation({
    mutationFn: (action: VerdictAction) => callParent<unknown>(() => action.kind === "variant"
      ? parentClient.lessonVerdicts.acceptAsVariant({ verdictId: action.verdictId })
      : parentClient.lessonVerdicts.decision({ verdictId: action.verdictId, decision: action.decision })),
    onMutate: () => setNotice(null),
    onSuccess: async (_result, action) => {
      if (action.kind === "variant") setNotice(messages.lessons.verdictVariantAdded);
      await queryClient.invalidateQueries({ queryKey: verdictsKey });
    },
  });
  const act = (action: VerdictAction) => {
    if (verdictAction.isPending) return;
    verdictAction.mutate(action);
  };

  const progress = progressQuery.isError ? [] : (progressQuery.data ?? []);
  const verdicts = verdictsQuery.data ?? [];
  const mockTests = mockQuery.data ?? [];
  const error = [verdictAction.error, verdictsQuery.error, mockQuery.error].find((cause) => cause != null);

  // Usługa rozpoznawania mowy jest wspólna dla zestawu — informacja raz, nie przy każdym celu.
  const speechService = progress.find((objective) => objective.school?.speechService)?.school?.speechService ?? null;

  return (
    <Paper component="section" withBorder radius="lg" p={{ base: "md", sm: "lg" }} className="pp-editor" data-testid="supervision-panel" aria-labelledby="supervision-title">
      <Stack gap="md">
        <div>
          <Title order={3} fz="lg" id="supervision-title">{messages.lessons.progressTitle}</Title>
          <Text size="sm" mt={4} className="pp-editor-muted" data-testid="grading-provider">
            {gradingModel ? fill(messages.lessons.gradingProvider, { model: gradingModel }) : messages.lessons.gradingProviderNone}
          </Text>
        </div>

        {childrenList.length > 0 && (
          <NativeSelect
            size="md"
            label={messages.decks.assignTitle}
            className="pp-sup-child"
            data-testid="supervision-child"
            value={childId ?? ""}
            onChange={(e) => setChildId(e.currentTarget.value || null)}
            data={childrenList.map((child) => ({ value: child.id, label: child.displayName }))}
          />
        )}

        {error != null && <Alert color="red" variant="light" role="alert" data-testid="supervision-error">{errorMessage(error)}</Alert>}
        {progressQuery.isError && (
          <Alert color="red" variant="light" role="alert" data-testid="supervision-progress-error">{errorMessage(progressQuery.error)}</Alert>
        )}
        {notice && <Alert color="green" variant="light" role="status" aria-live="polite" data-testid="supervision-notice">{notice}</Alert>}

        {!childId ? (
          <Text size="sm" className="pp-editor-muted">{messages.lessons.loadChild}</Text>
        ) : (
          <Stack gap="sm" data-testid="objective-progress">
            {speechService && (
              <Text size="sm" className="pp-editor-muted" data-testid="school-speech-service">
                {fill(messages.lessons.schoolSpeechService, { service: speechService })}
              </Text>
            )}
            {progress.map((objective) => (
              <ObjectiveCard key={objective.objectiveId} objective={objective} {...(onRegenerate ? { onRegenerate } : {})} />
            ))}
          </Stack>
        )}

        {childId && (
          <section data-testid="lesson-mock-reports" aria-label={messages.lessons.mockTestsTitle}>
            <Title order={4} fz="md" mb="xs">{messages.lessons.mockTestsTitle}</Title>
            {!mockQuery.isSuccess ? null : mockTests.length === 0 ? (
              <Text size="sm" className="pp-editor-muted" data-testid="lesson-mock-empty">{messages.lessons.mockTestsEmpty}</Text>
            ) : (
              <Stack gap="sm">
                <Text size="sm" className="pp-editor-muted">{messages.lessons.mockTestsRecent}</Text>
                <Stack component="ul" gap="sm" className="pp-sup-cards" data-testid="lesson-mock-list">
                  {mockTests.map((report, index) => (
                    <Paper component="li" withBorder radius="md" p="md" className="pp-sup-card" key={report.sessionId}
                      data-testid="lesson-mock-report" data-session-id={report.sessionId}>
                      <Stack gap={6}>
                        <Group justify="space-between" align="flex-start" gap="xs">
                          <Text fw={600}>{fill(messages.lessons.mockTestDate, { date: formatDate(report.startedAt) })}</Text>
                          <span className="pp-status-badge" data-tone={report.complete ? "success" : "warning"} data-testid={`lesson-mock-complete-${index}`}>
                            {report.complete ? messages.lessons.mockTestComplete : messages.lessons.mockTestPartial}
                          </span>
                        </Group>
                        <Text size="sm" className="pp-editor-muted">{fill(messages.lessons.mockTestBudget, { n: report.taskBudget })}</Text>
                        {report.objectives.map((objective) => (
                          <div key={objective.objectiveId} data-testid={`lesson-mock-objective-${objective.objectiveId}`}>
                            <Text size="sm" fw={600}>{objective.titlePl}</Text>
                            <Text size="sm" className="pp-editor-muted">{fill(messages.lessons.mockTestObjectiveCounts, { correct: objective.correct, total: objective.total, incorrect: objective.incorrect, unassessed: objective.unassessed, skipped: objective.skipped })}</Text>
                            {objective.modelGraded > 0 && (
                              <Text size="sm" className="pp-editor-muted">{fill(messages.lessons.mockTestModelGraded, { n: objective.modelGraded })}</Text>
                            )}
                            {objective.school && (
                              <div data-testid={`lesson-mock-school-${objective.objectiveId}`}>
                                <Text size="sm" className="pp-editor-muted">{fill(messages.lessons.mockTestSchoolLine, {
                                  ...objective.school.knowledge, ...objective.school.precision,
                                })}</Text>
                                {objective.school.formViolations > 0 && (
                                  <Text size="sm" className="pp-editor-muted">{fill(messages.lessons.mockTestSchoolForm, { n: objective.school.formViolations })}</Text>
                                )}
                                {objective.school.missingElements.length > 0 && (
                                  <Text size="sm" className="pp-editor-muted">{fill(messages.lessons.mockTestSchoolMissing, {
                                    elements: objective.school.missingElements.map((element) => `${element.text} (${element.count})`).join(", "),
                                  })}</Text>
                                )}
                                {objective.school.confusions && objective.school.confusions.length > 0 && (
                                  <Text size="sm" className="pp-editor-muted" data-testid={`mock-school-confusions-${objective.objectiveId}`}>{fill(messages.lessons.mockTestSchoolConfusions, {
                                    pairs: objective.school.confusions.map((pair) => `${fill(messages.lessons.schoolConfusion, pair)} (${pair.count})`).join(", "),
                                  })}</Text>
                                )}
                              </div>
                            )}
                            {objective.errorCategories.length > 0 && (
                              <div>
                                <Title order={5} className="pp-sup-subtitle">{messages.lessons.mockTestErrorsTitle}</Title>
                                <ul className="pp-sup-list">
                                  {objective.errorCategories.map((cat) => (
                                    <li key={cat.category}>
                                      <Text size="sm" className="pp-editor-muted">{fill(messages.lessons.mockTestErrorCount, { label: cat.labelPl, n: cat.count })}</Text>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        ))}
                      </Stack>
                    </Paper>
                  ))}
                </Stack>
                <Text size="sm" className="pp-editor-muted">{messages.lessons.mockTestNote}</Text>
              </Stack>
            )}
          </section>
        )}

        <section aria-labelledby="supervision-verdicts-title">
          <Title order={4} fz="md" mb="xs" id="supervision-verdicts-title">{messages.lessons.verdictsTitle}</Title>
          {!verdictsQuery.isSuccess ? null : verdicts.length === 0 ? (
            <Text size="sm" className="pp-editor-muted" data-testid="no-verdicts">{messages.lessons.noVerdicts}</Text>
          ) : (
            <Stack component="ul" gap="sm" className="pp-sup-cards" data-testid="verdict-list">
              {verdicts.map((verdict) => {
                return (
                  <Paper component="li" withBorder radius="md" p="md" className="pp-sup-card" key={verdict.id} data-testid={`verdict-${verdict.id}`}>
                    <Stack gap={6}>
                      <Group justify="space-between" align="flex-start" gap="xs" wrap="nowrap">
                        <Text size="sm" className="pp-editor-grow">
                          <strong>{messages.lessons.verdictAnswerLabel}:</strong> {verdict.childAnswer}
                        </Text>
                        <span className="pp-status-badge" data-tone={VERDICT_TONE[verdict.verdict] ?? "neutral"} data-testid={`verdict-value-${verdict.id}`}>
                          {messages.lessons.verdictValue[verdict.verdict] ?? verdict.verdict}
                        </span>
                      </Group>
                      {verdict.errorCategory && (
                        <Text size="sm" className="pp-editor-muted">{messages.lessons.verdictCategoryLabel}: {verdict.errorCategory}</Text>
                      )}
                      {verdict.note && <Text size="sm" className="pp-editor-muted">{messages.lessons.verdictNoteLabel}: {verdict.note}</Text>}
                      <Text size="sm" className="pp-editor-muted">{messages.lessons.verdictModelLabel}: {verdict.graderModel}</Text>
                      {verdict.parentDecision && (
                        <Text size="sm" fw={600} data-testid={`verdict-changed-${verdict.id}`}>
                          {messages.lessons.verdictChangedLater}
                          {" — "}
                          {messages.lessons.verdictDecision[verdict.parentDecision] ?? verdict.parentDecision}
                        </Text>
                      )}
                      <SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }} spacing="xs" verticalSpacing="xs" mt={4}>
                        <Button size="md" variant="default" data-testid={`verdict-confirm-${verdict.id}`} disabled={verdictAction.isPending}
                          onClick={() => act({ verdictId: verdict.id, kind: "decision", decision: "confirmed" })}>
                          {messages.lessons.verdictConfirm}
                        </Button>
                        <Button size="md" variant="default" data-testid={`verdict-correct-${verdict.id}`} disabled={verdictAction.isPending}
                          onClick={() => act({ verdictId: verdict.id, kind: "decision", decision: "overridden_correct" })}>
                          {messages.lessons.verdictOverrideCorrect}
                        </Button>
                        <Button size="md" variant="default" data-testid={`verdict-incorrect-${verdict.id}`} disabled={verdictAction.isPending}
                          onClick={() => act({ verdictId: verdict.id, kind: "decision", decision: "overridden_incorrect" })}>
                          {messages.lessons.verdictOverrideIncorrect}
                        </Button>
                        <Button size="md" variant="default" data-testid={`verdict-variant-${verdict.id}`} disabled={verdictAction.isPending}
                          onClick={() => act({ verdictId: verdict.id, kind: "variant" })}>
                          {messages.lessons.verdictAcceptVariant}
                        </Button>
                      </SimpleGrid>
                    </Stack>
                  </Paper>
                );
              })}
            </Stack>
          )}
        </section>
      </Stack>
    </Paper>
  );
}
