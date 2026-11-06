"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Center, Group, Loader, Paper, Stack, Text, Textarea, ThemeIcon, Title, UnstyledButton, VisuallyHidden } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { messages, type SourceMaterialPatch } from "@learning/contracts";
import { ApiCallError, callParent, errorMessage, parentClient } from "../api";
import { DECK_STATE_TONE } from "../deck-list-grouping";
import { ParentIcon } from "../ParentIcon";
import type { ParentRoute } from "../parent-routes";
import { httpStatusOf, orpc } from "../query-client";
import { runOnce } from "../run-once";
import type { EditorLeaveState } from "../useParentLeaveGuard";
import { subjectServiceInfo } from "../lessons/lesson-service-info";
import SourceFields from "./SourceFields";
import {
  deckCountLabel,
  deleteConfirmText,
  formatSourceDate,
  newLessonFromSource,
  newVocabularyFromSource,
  sourceLessonKinds,
  sourceLessonSubject,
  sourcePatch,
  sourceValuesValid,
  type SourceFormValues,
  type SourceLessonKind,
} from "./sources-state";
import "../decks-panel.css";
import "../deck-editor.css";
import "./sources-panel.css";

/** Stan źródła w chwili wejścia w edycję: zapis porównuje z nim pola i wysyła jego rewizję. */
interface EditBase {
  title: string;
  body: string;
  revision: number;
}

function isConflict(error: unknown): boolean {
  return httpStatusOf(error) === 409 || (error instanceof ApiCallError && error.code === "conflict");
}

const LESSON_BUTTONS: Array<{ kind: SourceLessonKind; label: string; testId: string; variant: "filled" | "light" }> = [
  { kind: "chapter", label: messages.sources.createChapterLesson, testId: "source-create-chapter", variant: "filled" },
  { kind: "school", label: messages.sources.createSchoolLesson, testId: "source-create-school", variant: "light" },
];

/**
 * Strona źródła (design 2026-10-30 §3.4): podgląd i edycja tekstu, przyciski
 * tworzenia lekcji rozdziału i szkolnej (tylko dla przedmiotów obecnych
 * w katalogu lekcji) i zestawu słówek (zawsze, §6.2), zestawy z tego źródła
 * oraz usunięcie z potwierdzeniem
 * podającym liczbę zestawów. Edycja wysyła tylko zmienione pola z rewizją
 * z chwili wejścia w edycję — zmiana z innego okna kończy się konfliktem (409),
 * a nie cichym nadpisaniem. Fokus: po konflikcie na „Odśwież”, po innym błędzie
 * na komunikacie błędu; „Zapisano zmiany.” ogłasza stały region na żywo.
 */
export default function SourcePage({
  sourceId,
  onNavigate,
  registerEditorState,
}: {
  sourceId: string;
  onNavigate: (route: ParentRoute, options?: { replace?: boolean }) => void;
  registerEditorState: (state: EditorLeaveState) => void;
}) {
  const queryClient = useQueryClient();
  const options = orpc.sources.get.queryOptions({ input: { sourceId } });
  const query = useQuery(options);
  const catalogQuery = useQuery(orpc.lessonCatalog.get.queryOptions());
  const source = query.data;
  const [base, setBase] = useState<EditBase | null>(null);
  const [values, setValues] = useState<SourceFormValues>({ title: "", body: "" });
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // każdy nowy błąd (także ten sam tekst drugi raz) przenosi fokus na komunikat
  const [errorShown, setErrorShown] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const savingRef = useRef(false);
  const deletingRef = useRef(false);
  const mounted = useRef(true);
  const editButton = useRef<HTMLButtonElement>(null);
  const titleField = useRef<HTMLInputElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const errorAlert = useRef<HTMLDivElement>(null);
  const restoreEditFocus = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = useMutation({
    mutationFn: (patch: SourceMaterialPatch) => callParent(() => parentClient.sources.update({ sourceId, ...patch })),
  });
  const remove = useMutation({
    mutationFn: () => callParent(() => parentClient.sources.delete({ sourceId })),
  });
  const saving = update.isPending;
  const editing = base !== null;
  const patch = base ? sourcePatch(base, values) : null;
  const dirty = patch !== null;

  useEffect(() => {
    registerEditorState({ dirty, busy: saving || deleting });
  }, [registerEditorState, dirty, saving, deleting]);
  useEffect(() => () => registerEditorState({ dirty: false, busy: false }), [registerEditorState]);

  // „Edytuj” znika razem z podglądem: fokus przechodzi do pola tytułu, a po wyjściu
  // z edycji wraca do „Edytuj” (inaczej spadłby na <body>)
  useEffect(() => {
    if (editing) {
      titleField.current?.focus();
    } else if (restoreEditFocus.current) {
      restoreEditFocus.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  // po konflikcie „Zapisz” jest wyłączone — następny krok to „Odśwież”
  useEffect(() => {
    if (conflict) refreshButton.current?.focus();
  }, [conflict]);
  useEffect(() => {
    if (errorShown > 0) errorAlert.current?.focus();
  }, [errorShown]);

  const showError = (message: string) => {
    setError(message);
    setErrorShown((count) => count + 1);
  };

  const startEdit = () => {
    if (!source) return;
    setBase({ title: source.title, body: source.body, revision: source.revision });
    setValues({ title: source.title, body: source.body });
    setConflict(false);
    setError(null);
    setStatus(null);
  };

  const stopEdit = () => {
    restoreEditFocus.current = true;
    setBase(null);
    setConflict(false);
  };

  const save = async (): Promise<void> => {
    if (savingRef.current || !base || conflict) return;
    const changes = sourcePatch(base, values);
    if (!changes || !sourceValuesValid(values)) return;
    savingRef.current = true;
    setError(null);
    setStatus(null);
    try {
      const saved = await update.mutateAsync(changes);
      queryClient.setQueryData(options.queryKey, saved);
      void queryClient.invalidateQueries({ queryKey: orpc.sources.list.queryKey() });
      if (!mounted.current) return;
      stopEdit();
      setStatus(messages.sources.saved);
    } catch (cause) {
      if (!mounted.current) return;
      const code = httpStatusOf(cause);
      if (isConflict(cause)) setConflict(true);
      // źródło usunięte w innym oknie: odczyt też się o tym dowie — po wyjściu z edycji
      // strona pokaże brak źródła zamiast starej kopii z pamięci podręcznej
      else if (code === 404) {
        showError(messages.sources.notFound);
        void query.refetch();
      }
      // 401: logowanie w oknie nad stroną otwiera globalny handler, edycja zostaje
      else if (code !== 401) showError(errorMessage(cause));
    } finally {
      savingRef.current = false;
    }
  };

  /** Odświeżenie po konflikcie odrzuca wpisane zmiany — najpierw potwierdzenie. */
  const confirmRefresh = () => {
    if (refreshing) return;
    modals.openConfirmModal({
      title: messages.sources.refreshTitle,
      centered: true,
      radius: "lg",
      children: <Text size="sm">{messages.sources.refreshConfirm}</Text>,
      labels: { confirm: messages.sources.refresh, cancel: messages.sources.cancel },
      confirmProps: { size: "md", "data-testid": "source-refresh-confirm" } as Record<string, unknown>,
      cancelProps: { size: "md", variant: "default", "data-autofocus": true, "data-testid": "source-refresh-cancel" } as Record<string, unknown>,
      attributes: { content: { "data-testid": "source-refresh-dialog" } },
      onConfirm: runOnce(() => void refresh()),
    });
  };

  /** Po konflikcie: najnowsza wersja źródła zastępuje edycję (zmiany z tego okna przepadają). */
  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      const result = await query.refetch();
      if (!mounted.current) return;
      if (result.isError) {
        // źródło usunięte w innym oknie: zmiany i tak odrzucono — strona pokazuje brak źródła
        if (httpStatusOf(result.error) === 404) stopEdit();
        else showError(errorMessage(result.error));
        return;
      }
      setError(null);
      stopEdit();
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  };

  const afterDelete = () => {
    // usunięte źródło nie jest już edycją ani zapisem w toku — przejście do listy nie pyta o wyjście
    registerEditorState({ dirty: false, busy: false });
    // strona usuniętego źródła znika z historii — „wstecz” prowadzi dalej, nie do pustej strony
    onNavigate({ section: "sources" }, { replace: true });
    queryClient.removeQueries({ queryKey: options.queryKey, exact: true });
    void queryClient.invalidateQueries({ queryKey: orpc.sources.list.queryKey() });
    void queryClient.invalidateQueries({ queryKey: orpc.decks.list.queryKey() });
  };

  const runDelete = async (): Promise<void> => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setError(null);
    setStatus(null);
    try {
      await remove.mutateAsync();
      if (mounted.current) afterDelete();
    } catch (cause) {
      if (!mounted.current) return;
      const code = httpStatusOf(cause);
      // źródło usunięte już w innym oknie — efekt jest ten sam
      if (code === 404) afterDelete();
      else if (code !== 401) showError(errorMessage(cause));
    } finally {
      deletingRef.current = false;
      if (mounted.current) setDeleting(false);
    }
  };

  const confirmDelete = () => {
    if (!source || deletingRef.current) return;
    modals.openConfirmModal({
      title: messages.sources.deleteTitle,
      centered: true,
      radius: "lg",
      children: <Text size="sm">{deleteConfirmText(source.decks.length)}</Text>,
      labels: { confirm: messages.sources.deleteButton, cancel: messages.sources.cancel },
      confirmProps: { color: "red", size: "md", "data-testid": "source-delete-confirm" } as Record<string, unknown>,
      cancelProps: { size: "md", variant: "default", "data-autofocus": true, "data-testid": "source-delete-cancel" } as Record<string, unknown>,
      attributes: { content: { "data-testid": "source-delete-dialog" } },
      onConfirm: runOnce(() => void runDelete()),
    });
  };

  const back = () => onNavigate({ section: "sources" });
  const backButton = (
    <Button variant="subtle" size="md" px={4} className="pp-editor-back" data-testid="source-back" onClick={back}
      leftSection={<ParentIcon name="chevron-left" />}>
      {messages.sources.backToList}
    </Button>
  );

  // Źródło usunięte w innym oknie: odświeżenie w tle kończy się 404, choć dane są
  // jeszcze w pamięci podręcznej — wtedy też „nie ma takiego źródła” (edycja w toku
  // zostaje, żeby wpisany tekst dało się skopiować; jej zapis pokaże ten sam komunikat).
  const gone = httpStatusOf(query.error) === 404;
  if (source === undefined || (gone && !editing)) {
    if (source === undefined && query.isPending) {
      return (
        <Center py="xl" role="status" data-testid="source-loading">
          <Group gap="sm"><Loader size="sm" /><Text>{messages.parentShell.loading}</Text></Group>
        </Center>
      );
    }
    return (
      <Stack gap="md" align="flex-start" data-testid={gone ? "source-not-found" : "source-load-error"}>
        {backButton}
        <Alert color={gone ? "gray" : "red"} variant="light" w="100%" role={gone ? undefined : "alert"}>
          <Stack gap="sm" align="flex-start">
            <Text size="sm">{gone ? messages.sources.notFound : errorMessage(query.error)}</Text>
            {!gone && (
              <Button size="md" variant="light" color="red" data-testid="source-load-retry" onClick={() => void query.refetch()}>
                {messages.parentShell.retry}
              </Button>
            )}
          </Stack>
        </Alert>
      </Stack>
    );
  }

  // Przyciski tylko dla przedmiotów z katalogu lekcji (inaczej formularz po cichu wybrałby
  // inny przedmiot); w trakcie wczytywania katalogu wyłączone, przy jego błędzie formularz
  // pokaże własny komunikat z ponowieniem.
  const lessonKinds = sourceLessonKinds(catalogQuery.data);
  const lessonButtons = LESSON_BUTTONS.filter((button) => lessonKinds === null || lessonKinds.includes(button.kind));
  // bez klucza OpenRouter na serwerze lekcja ze źródła nie ma jak się wygenerować
  const generationUnavailable = catalogQuery.data?.lessonGenerationAvailable === false;
  // przedmiot z agentem puli (`checkService`) ma własne usługi i drugi model
  const buttonServices = lessonButtons
    .map((button) => ({ kind: button.kind, info: subjectServiceInfo(sourceLessonSubject(catalogQuery.data, button.kind)) }))
    .filter(({ info }) => info.check !== null);

  return (
    <Stack gap="lg" className="pp-editor pp-source-page" data-testid="source-page">
      <div>
        {backButton}
        <Title order={1} fz={{ base: 22, sm: 26 }} className="pp-editor-title" data-testid="source-heading">{source.title}</Title>
        <Text size="sm" mt={4} className="pp-editor-muted" data-testid="source-meta">
          {/* jak na liście: bez zestawów zarchiwizowanych; potwierdzenie usunięcia liczy wszystkie (każdy traci odnośnik) */}
          {[messages.sources.updatedAt.replace("{date}", formatSourceDate(source.updatedAt)), deckCountLabel(source.deckCount)].join(" · ")}
        </Text>
        {/* stały region na żywo: czytnik ogłasza samą zmianę tekstu („Zapisano zmiany.”) */}
        <Text size="sm" mt={status ? 4 : 0} role="status" data-testid="source-status">{status ?? ""}</Text>
      </div>

      <div className="pp-source-actions">
        {lessonButtons.map((button) => (
          <Button key={button.kind} size="md" variant={button.variant} leftSection={<ParentIcon name="graduation-cap" />}
            data-testid={button.testId} disabled={catalogQuery.isPending || generationUnavailable}
            onClick={() => onNavigate(newLessonFromSource(source.id, button.kind))}>
            {button.label}
          </Button>
        ))}
        {/* zestaw słówek nie zależy od katalogu przedmiotów lekcji — przycisk jest zawsze */}
        <Button size="md" variant="light" leftSection={<ParentIcon name="book-open" />} data-testid="source-create-vocabulary"
          onClick={() => onNavigate(newVocabularyFromSource(source.id))}>
          {messages.sources.createVocabulary}
        </Button>
      </div>
      {generationUnavailable && lessonButtons.length > 0 && (
        <Text size="sm" className="pp-editor-muted" role="status" data-testid="source-generation-unavailable">
          {messages.lessons.generationErrors.lesson_agent_unavailable}
        </Text>
      )}
      {lessonButtons.length === 0 && (
        <Text size="sm" className="pp-editor-muted" data-testid="source-no-lesson-subjects">{messages.sources.noLessonSubjects}</Text>
      )}
      {buttonServices.map(({ kind, info }, index) => (
        <Stack key={kind} gap={4}>
          {/* ten sam komunikat o generowaniu (te same usługi) pokazujemy raz, gdy oba przyciski prowadzą do agenta */}
          {info.generation && !buttonServices.slice(0, index).some((earlier) => earlier.info.generation === info.generation) && (
            <Text size="sm" className="pp-editor-muted" data-testid={`source-generation-service-${kind}`}>{info.generation}</Text>
          )}
          {info.check && <Text size="sm" className="pp-editor-muted" data-testid={`source-check-service-${kind}`}>{info.check}</Text>}
          {info.openCheck && <Text size="sm" className="pp-editor-muted" data-testid={`source-open-check-service-${kind}`}>{info.openCheck}</Text>}
        </Stack>
      ))}

      {error && (
        <Alert ref={errorAlert} tabIndex={-1} color="red" variant="light" role="alert" data-testid="source-error" icon={<ParentIcon name="alert-triangle" />}>
          {error}
        </Alert>
      )}

      <Paper withBorder radius="lg" p={{ base: "md", sm: "lg" }}>
        {editing ? (
          <Stack gap="md">
            <SourceFields values={values} onChange={setValues} disabled={saving || refreshing} titleRef={titleField} />
            {source.decks.length > 0 && (
              <Text size="sm" className="pp-editor-muted" data-testid="source-edit-hint">{messages.sources.editHint}</Text>
            )}
            {conflict && (
              <Alert color="yellow" variant="light" role="alert" data-testid="source-conflict" icon={<ParentIcon name="alert-triangle" />}>
                <Stack gap="sm" align="flex-start">
                  <Text size="sm">{messages.sources.conflict}</Text>
                  <Button ref={refreshButton} size="md" variant="default" leftSection={<ParentIcon name="refresh" />} data-testid="source-conflict-refresh"
                    disabled={refreshing} onClick={confirmRefresh}>
                    {messages.sources.refresh}
                  </Button>
                </Stack>
              </Alert>
            )}
            <Group justify="flex-end" gap="sm">
              <Button size="md" variant="default" data-testid="source-edit-cancel" disabled={saving} onClick={stopEdit}>
                {messages.sources.cancel}
              </Button>
              <Button
                size="md"
                data-testid="source-save"
                leftSection={saving ? <Loader size={16} color="currentColor" /> : undefined}
                disabled={saving || conflict || patch === null || !sourceValuesValid(values)}
                onClick={() => void save()}
              >
                {saving ? messages.sources.saving : messages.sources.save}
              </Button>
            </Group>
          </Stack>
        ) : (
          <Stack gap="sm">
            <Group justify="space-between" align="center" gap="sm">
              <Title order={2} fz="lg" id="source-preview-label">{messages.sources.previewLabel}</Title>
              <Button ref={editButton} size="md" variant="default" leftSection={<ParentIcon name="pencil" />} data-testid="source-edit"
                disabled={deleting} onClick={startEdit}>
                {messages.sources.edit}
              </Button>
            </Group>
            {/* pole tylko do odczytu: przewijane i dostępne z klawiatury natywnie, bez tabIndex */}
            <Textarea
              size="md"
              readOnly
              autosize
              maxRows={12}
              value={source.body}
              className="pp-source-preview"
              data-testid="source-preview"
              aria-labelledby="source-preview-label"
            />
          </Stack>
        )}
      </Paper>

      <Stack component="section" gap="xs" aria-labelledby="source-decks-heading">
        <Title order={2} fz="lg" id="source-decks-heading">{messages.sources.decksHeading}</Title>
        {source.decks.length === 0 ? (
          <Text size="sm" className="pp-editor-muted" data-testid="source-no-decks">{messages.sources.noDecks}</Text>
        ) : (
          <Stack gap="xs" component="ul" className="pp-decks-list">
            {source.decks.map((deck, index) => (
              <Paper key={deck.deckId} component="li" radius="lg" withBorder className="pp-decks-card">
                <UnstyledButton className="pp-decks-row" data-testid={`source-deck-${index}`} data-deck-id={deck.deckId}
                  onClick={() => onNavigate({ section: "decks", deckId: deck.deckId })}>
                  <ThemeIcon size={40} radius="md" variant="light" color={deck.kind === "lesson" ? "violet" : "brand"} aria-hidden="true">
                    <ParentIcon name={deck.kind === "lesson" ? "graduation-cap" : "book-open"} className="pp-decks-kind-icon" />
                  </ThemeIcon>
                  <Box className="pp-decks-body">
                    <Text fw={600} className="pp-decks-title">{deck.title}</Text>
                    <VisuallyHidden>{messages.lessons.kindLabel[deck.kind]}</VisuallyHidden>
                    <span className="pp-status-badge" data-tone={DECK_STATE_TONE[deck.state]}>{messages.decks.states[deck.state]}</span>
                    {deck.stale && (
                      <Text size="sm" className="pp-decks-muted" data-testid={`source-deck-stale-${index}`}>{messages.sources.sourceChanged}</Text>
                    )}
                  </Box>
                  <ParentIcon name="chevron-right" className="pp-decks-chevron" />
                </UnstyledButton>
              </Paper>
            ))}
          </Stack>
        )}
      </Stack>

      <div>
        <Button variant="subtle" color="red" size="md" leftSection={<ParentIcon name="trash-2" />} data-testid="source-delete"
          disabled={editing || deleting} onClick={confirmDelete}>
          {deleting ? messages.sources.deleting : messages.sources.delete}
        </Button>
      </div>
    </Stack>
  );
}
