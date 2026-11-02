"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Accordion, ActionIcon, Alert, Button, Group, Loader, Menu, Modal, NumberInput, Paper, Stack, Tabs, Text, TextInput, Textarea, Title } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  messages,
  CalculationSpecSchema,
  type CalculationSpec,
  type ChildDto,
  type LessonDeckDto,
  type LessonDraftDto,
  type LessonExerciseErrors,
} from "@learning/contracts";
import { callParent, ApiCallError, errorMessage, isMediaPendingError, parentClient } from "../api";
import type { AssignmentTestSettings } from "../AssignmentTestGoalFields";
import DeckSessionTaskBudgetSettings from "../DeckSessionTaskBudgetSettings";
import type { EditorLeaveState } from "../useParentLeaveGuard";
import { orpc } from "../query-client";
import LessonSupervisionPanel from "./LessonSupervisionPanel";
import LessonExerciseCard, { type CalculationControls } from "./LessonExerciseCard";
import ArchiveLessonDialog from "./ArchiveLessonDialog";
import LessonSourceNote from "./LessonSourceNote";
import PromptAudioControls, { cardAudioTargetLabel, VoiceToneSelect } from "./PromptAudioControls";
import { EditorActionBar, EditorAssignments, EditorErrorText } from "../EditorAssignments";
import { ParentIcon } from "../ParentIcon";
import { runOnce } from "../run-once";
import { polishPlural } from "../deck-list-grouping";
import "../deck-editor.css";
import "./lesson-panels.css";
import {
  createLessonSnapshot,
  applyCalculationPreview,
  formatRejectedReason,
  otherRejectedCount,
  groupCalculationFamilies,
  groupExercisesByObjectiveAndStage,
  keywordsAnswerOf,
  lessonExerciseChanged,
  missingListenAudioCount,
  lessonThemesPatch,
  nextRequiredElementId,
  toLessonDraftPatch,
  topRejectedReasons,
  type EditableDynamicCard,
  type EditableLessonExercise,
  type EditableLessonForm,
  type LessonEditorSnapshot,
} from "./lesson-editor-state";

/** Czy zapisany werdykt dowolnych odpowiedzi jest wyłączony (brak modelu oceniającego). */
function gradingDisabled(deck: LessonDeckDto | null): boolean {
  // Typowane pole `grading` (zadanie 16) zastąpiło rzutowanie
  // `deck as unknown as {gradingAvailable?: boolean}`.
  return deck?.grading.available === false;
}

/** Liczba ćwiczeń do dogenerowania: całkowita 1–60 (kontrakt polecenia). */
export function regenCountValid(count: number): boolean {
  return Number.isInteger(count) && count >= 1 && count <= 60;
}

/**
 * Odstęp odpytywania lekcji: co 1 s, gdy trwa generowanie albo media pokazanej wersji czekają;
 * co 3 s, gdy czekają tylko nagrania pytań i kart (trwają kilka sekund, a zlecenie, którego worker
 * nie wykona, nie powinno obciążać serwera odpytywaniem co sekundę).
 */
export function lessonPollInterval(deck: LessonDeckDto | undefined): number | false {
  if (!deck) return false;
  const generating = deck.generation?.state === "queued" || deck.generation?.state === "running";
  const visible = deck.draft ?? deck.published;
  const assetsPending = visible?.assets.some((asset) => asset.state === "pending") ?? false;
  // nagrania pytań i kart nie są w `assets` (serwer je pomija) — ich stan niosą ćwiczenia i `cardAudio`
  // (zdanie „Posłuchaj i wybierz” — `sentenceAudio` — jest tak samo poza `assets`)
  const promptAudioPending = visible?.exercises.some((exercise) => exercise.promptAudio?.state === "pending" || exercise.sentenceAudio?.state === "pending") ?? false;
  const cardAudioPending = visible?.cardAudio?.some((card) => card.audio.state === "pending") ?? false;
  if (generating || assetsPending) return 1000;
  return promptAudioPending || cardAudioPending ? 3000 : false;
}

/**
 * Przegląd i edycja jednej lekcji: ćwiczenia pogrupowane wg reguł i etapów
 * z etykietami typów, edycja pól zależnie od typu, usuwanie, walidacja per
 * ćwiczenie (400), zapis z `expectedEditNumber` i obsługą konfliktu (409),
 * dogenerowanie per reguła, pokrycie etapów, karty wyjaśnienia, status TTS,
 * publikacja (409 pokrycia → lista braków), nowa wersja i przypisania z celem
 * kartkówki „Gramatyka". Reużywa `useParentLeaveGuard` (przez propsy) oraz
 * logikę stanu z `lesson-editor-state.ts`.
 */
export default function LessonEditor({
  deckId,
  childrenList,
  onBack,
  onEditorStateChange,
  onArchived,
  onOpenSource,
}: {
  deckId: string;
  childrenList: ChildDto[];
  onBack: () => void;
  onEditorStateChange: (state: EditorLeaveState) => void;
  /** Lekcja usunięta z listy z menu ⋯ — panel oznacza ją od razu i wraca do listy. */
  onArchived: () => void;
  /** Link „Ze źródła: …” — otwiera stronę źródła w panelu (przez leave guard). */
  onOpenSource: (sourceId: string) => void;
}) {
  const [deck, setDeck] = useState<LessonDeckDto | null>(null);
  const [form, setForm] = useState<EditableLessonForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [exerciseErrors, setExerciseErrors] = useState<Record<number, string[]>>({});
  const [regenCounts, setRegenCounts] = useState<Record<string, number>>({});
  const [assignDates, setAssignDates] = useState<Record<string, string>>({});
  const [assignSettings, setAssignSettings] = useState<Record<string, AssignmentTestSettings>>({});
  const [unassigningChildId, setUnassigningChildId] = useState<string | null>(null);
  // Budżet sesji nauki (decks.session_task_budget): null = bez lokalnej zmiany,
  // wartość z DTO obowiązuje. Zapis przez PATCH /parent/decks/:id (wspólny
  // dla słówek i lekcji — konfiguracja runtime, poza szkicem wersji).
  const [sessionBudgetEdit, setSessionBudgetEdit] = useState<number | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  // Edytowalne przykłady AI per cel (wym. 3.3). Trzymane lokalnie, bo serializacja
  // PATCH-a ćwiczeń żyje w `lesson-editor-state.ts` (poza zakresem tej edycji);
  // przykłady dokładamy do ciała PATCH w `save()`. `null` = jeszcze nie zasiane.
  const [examplesForm, setExamplesForm] = useState<Record<string, string[]> | null>(null);
  // Tematy zdań (migawka z tworzenia lekcji) w szkicu można tylko usunąć: `[]` po
  // „Usuń tematy”. Do PATCH trafiają wyłącznie po zmianie (`lessonThemesPatch`).
  const [interestsForm, setInterestsForm] = useState<string[] | null>(null);
  // Układ (szkic 6b): zakładka, otwarte karty ćwiczeń i grupy (null = domyślne dla szerokości ekranu).
  const compact = useMediaQuery("(max-width: 37.49em)", false, { getInitialValueInEffect: false });
  const [tab, setTab] = useState("exercises");
  const [openCards, setOpenCards] = useState<ReadonlySet<string>>(new Set());
  // Funkcje kart ćwiczeń są stabilne (karta jest `memo`) i wołają wersje z ostatniego renderu.
  const cardActionsRef = useRef<{
    toggle: (cardKey: string) => void;
    mutate: (clientKey: string, patch: Partial<EditableLessonExercise>) => void;
    remove: (clientKey: string) => void;
    play: (assetId: string) => void;
  } | null>(null);
  const cardActions = useMemo(() => ({
    onToggle: (cardKey: string) => cardActionsRef.current?.toggle(cardKey),
    onMutate: (clientKey: string, patch: Partial<EditableLessonExercise>) => cardActionsRef.current?.mutate(clientKey, patch),
    onRemove: (clientKey: string) => cardActionsRef.current?.remove(clientKey),
    onPlay: (assetId: string) => cardActionsRef.current?.play(assetId),
  }), []);
  const [openObjectives, setOpenObjectives] = useState<string[] | null>(null);
  const [openStages, setOpenStages] = useState<string[] | null>(null);
  const [regenTarget, setRegenTarget] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  // błędy przy sekcji, której dotyczą (jak w edytorze zestawu): liczba pytań, przypisanie dziecka
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [assignErrors, setAssignErrors] = useState<Record<string, string>>({});
  const setAssignError = (childId: string, message: string | null) =>
    setAssignErrors((current) => {
      const next = { ...current };
      if (message) next[childId] = message; else delete next[childId];
      return next;
    });
  const confirmIds = useRef<string[]>([]);
  const lessonMenuRef = useRef<HTMLButtonElement>(null);

  const [calculationInputs, setCalculationInputs] = useState<Record<string, string>>({});
  const [calculationPreviews, setCalculationPreviews] = useState<Record<string, { fingerprint: string; status: "pending" | "ready" | "error" }>>({});
  const calculationRequests = JSON.stringify((form?.exercises ?? []).filter(ex => ex.calculation).map(ex => ({ clientKey: ex.clientKey, calculation: ex.calculation })));
  const calculationBlocked = (form?.exercises ?? []).some(ex => ex.exerciseType === "lesson_calculation" && (
    !ex.calculation || !CalculationSpecSchema.safeParse(ex.calculation).success ||
    calculationPreviews[ex.clientKey]?.fingerprint !== JSON.stringify(ex.calculation) || calculationPreviews[ex.clientKey]?.status !== "ready"
  ));

  // Last requested parameters per variant: only changed variants are previewed
  // again, and a late response for older parameters is ignored.
  const previewRequested = useRef<Record<string, string>>({});
  const calculationsEditable = deck?.draft != null;
  useEffect(() => {
    if (!calculationsEditable) return;
    const requests = JSON.parse(calculationRequests) as { clientKey: string; calculation: CalculationSpec }[];
    for (const { clientKey, calculation } of requests) {
      const fingerprint = JSON.stringify(calculation);
      if (previewRequested.current[clientKey] === fingerprint) continue;
      previewRequested.current[clientKey] = fingerprint;
      const current = () => previewRequested.current[clientKey] === fingerprint;
      const settle = (status: "pending" | "ready" | "error") =>
        setCalculationPreviews(previews => ({ ...previews, [clientKey]: { fingerprint, status } }));
      if (!CalculationSpecSchema.safeParse(calculation).success) { settle("error"); continue; }
      settle("pending");
      void callParent(() => parentClient.lessons.previewCalculation(calculation)).then(preview => {
        if (!current()) return;
        setForm(form => form ? { ...form, exercises: form.exercises.map(ex => ex.clientKey === clientKey ? applyCalculationPreview(ex, calculation, preview) : ex) } : form);
        settle("ready");
      }).catch(() => { if (current()) settle("error"); });
    }
  }, [calculationRequests, calculationsEditable]);

  const dirty = useRef(false);
  const conflictActive = useRef(false);
  const busyRef = useRef(false);
  const regenLock = useRef(false);
  const baseSnapshot = useRef<LessonEditorSnapshot | null>(null);
  const newKey = useCallback(() => crypto.randomUUID(), []);
  const queryClient = useQueryClient();
  const enterConflict = (value: boolean) => {
    conflictActive.current = value;
    setConflict(value);
  };

  // Polecenia edytora idą przez mutację TanStack: 401 obsługuje globalny
  // handler (logowanie w oknie przy niezapisanych zmianach), a sukces odświeża
  // listę zestawów. Każde wywołanie ma własną obietnicę i obsługę błędu.
  const command = useMutation({
    mutationFn: (call: () => Promise<unknown>) => callParent(call),
    // w tle — polecenie nie czeka na pobranie listy (zwrócona obietnica wstrzymałaby mutateAsync)
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: orpc.decks.list.queryKey() }); },
  });
  const { mutateAsync } = command;
  const run = useCallback(<T,>(call: () => Promise<T>): Promise<T> => mutateAsync(call) as Promise<T>, [mutateAsync]);
  // podgląd rachunku przed zapisem: odczyt bez zmiany danych — bez odświeżania listy zestawów, 401 jak w poleceniach
  const { mutateAsync: previewCalculation } = useMutation({
    mutationFn: (calculation: CalculationSpec) => callParent(() => parentClient.lessons.previewCalculation(calculation)),
  });

  const setBusyState = (value: boolean) => {
    busyRef.current = value;
    setBusy(value);
    onEditorStateChange({ dirty: dirty.current, busy: value });
  };
  const markDirty = () => {
    dirty.current = true;
    setIsDirty(true);
    onEditorStateChange({ dirty: true, busy: busyRef.current });
  };

  useEffect(() => {
    onEditorStateChange({ dirty: isDirty || conflict, busy });
    return () => onEditorStateChange({ dirty: false, busy: false });
  }, [onEditorStateChange, isDirty, busy, conflict]);

  // Odczyt lekcji (TanStack Query, jak edytor zestawu w fazie 5a). Odpowiedź
  // trafia do lokalnej bazy formularza w chwili nadejścia — w funkcji
  // zapytania, z warunkami dawnego `load()` (bez niezapisanych zmian i bez
  // konfliktu) sprawdzanymi wtedy, a nie w efekcie po renderze. Odpowiedź
  // anulowanego odczytu nie trafia nigdzie (jak dawniej wersja żądania).
  const manualLoads = useRef(0);
  const arrival = useRef({ data: (_: LessonDeckDto) => {}, error: (_: unknown) => {} });
  arrival.current = {
    data: (result) => {
      if (!dirty.current && !conflictActive.current) setDeck(result);
    },
    // błąd odczytu po poleceniu obsługuje samo polecenie; tu tylko pierwszy odczyt i odpytywanie
    error: (cause) => {
      if (manualLoads.current === 0 && !dirty.current && !conflictActive.current) setError(errorMessage(cause));
    },
  };
  const lessonOptions = orpc.lessons.get.queryOptions({ input: { deckId } });
  const baseQueryFn = lessonOptions.queryFn!;
  const lessonQuery = useQuery({
    ...lessonOptions,
    queryFn: async (context) => {
      try {
        const result = await baseQueryFn(context);
        if (!context.signal.aborted) arrival.current.data(result);
        return result;
      } catch (cause) {
        if (!context.signal.aborted) arrival.current.error(cause);
        throw cause;
      }
    },
    retry: false,
    // ponowne otwarcie lekcji zaczyna od świeżego odczytu, nie od pamięci podręcznej
    gcTime: 0,
    // odstęp z lokalnej bazy formularza (jak dawny setInterval): przy niezapisanych
    // zmianach odpytywanie trwa, ale odpowiedzi nie zmieniają bazy
    refetchInterval: lessonPollInterval(deck ?? undefined),
    refetchIntervalInBackground: true,
  });

  /** Ponowny odczyt po poleceniu; `false` = odczyt się nie udał. */
  const { refetch } = lessonQuery;
  const load = useCallback(async (): Promise<boolean> => {
    manualLoads.current += 1;
    try {
      const result = await refetch();
      if (!result.isError) return true;
      if (!dirty.current && !conflictActive.current) setError(errorMessage(result.error));
      return false;
    } finally {
      manualLoads.current -= 1;
    }
  }, [refetch]);

  /**
   * Świeży odczyt lekcji poza bazą formularza (konflikt wersji). Trwające
   * odpytanie jest najpierw anulowane — inaczej `fetchQuery` zwróciłby jego
   * (starszą) odpowiedź zamiast nowego odczytu.
   */
  const fetchRemote = useCallback(async () => {
    const options = orpc.lessons.get.queryOptions({ input: { deckId } });
    await queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
    return queryClient.fetchQuery({ ...options, retry: false, staleTime: 0, gcTime: 0 });
  }, [queryClient, deckId]);

  const catalogQuery = useQuery(orpc.lessonCatalog.get.queryOptions());
  const catalog = catalogQuery.data ?? null;
  const catalogError = catalogQuery.error;
  useEffect(() => {
    if (catalogError) setError(errorMessage(catalogError));
  }, [catalogError]);

  const draft = deck?.draft ?? null;
  const active: LessonDraftDto | null = draft ?? deck?.published ?? null;
  const editable = draft !== null;

  const generating = deck?.generation?.state === "queued" || deck?.generation?.state === "running";
  const generationFailure = deck?.generation?.errorCode
    ? messages.lessons.generationErrors[deck.generation.errorCode] ?? messages.lessons.generationFailed
    : messages.lessons.generationFailed;

  // Formularz podąża za widoczną wersją, dopóki rodzic nie zaczął edytować.
  useEffect(() => {
    if (!active || dirty.current) return;
    const snapshot = createLessonSnapshot(active, newKey);
    if (draft) baseSnapshot.current = snapshot;
    setForm(snapshot.form);
    setCalculationInputs({});
    setExamplesForm(structuredClone(active.examples ?? {}));
    setInterestsForm([...(active.interests ?? [])]);
  }, [active, draft, newKey]);

  useEffect(() => {
    setSessionBudgetEdit(null);
  }, [deckId]);

  const mutateExercise = (clientKey: string, patch: Partial<EditableLessonExercise>) => {
    markDirty();
    setForm((current) =>
      current
        ? { ...current, exercises: current.exercises.map((ex) => (ex.clientKey === clientKey ? { ...ex, ...patch } : ex)) }
        : current,
    );
  };

  const mutateCalculation = (ex: EditableLessonExercise, calculation: CalculationSpec) => mutateExercise(ex.clientKey, { calculation });
  const mutateCalculationNumber = (ex: EditableLessonExercise, field: string, text: string) => {
    const calculation = ex.calculation!;
    setCalculationInputs(current => ({ ...current, [ex.clientKey + ":" + field]: text }));
    const value = text.trim() === "" ? Number.NaN : Number(text.replace(",", "."));
    if (field === "tolerance") mutateCalculation(ex, { ...calculation, tolerance: text.trim() === "" ? undefined : value });
    else mutateCalculation(ex, { ...calculation, params: { ...calculation.params, [field]: value } } as CalculationSpec);
  };

  const removeExercise = (clientKey: string) => {
    markDirty();
    setExerciseErrors({});
    setForm((current) =>
      current ? { ...current, exercises: current.exercises.filter((ex) => ex.clientKey !== clientKey) } : current,
    );
  };

  const mutateDynamicObjective = (objectiveId: string, patch: Partial<{ titlePl: string; cards: EditableDynamicCard[] }>) => {
    markDirty();
    setForm((current) =>
      current?.dynamicObjectives
        ? { ...current, dynamicObjectives: current.dynamicObjectives.map((o) => (o.id === objectiveId ? { ...o, ...patch } : o)) }
        : current,
    );
  };

  const removeDynamicObjective = (objectiveId: string) => {
    markDirty();
    // błędy 400 są kluczowane indeksem — po usunięciu ćwiczeń zagadnienia wskazywałyby inne karty
    setExerciseErrors({});
    setForm((current) =>
      current?.dynamicObjectives
        ? {
            ...current,
            dynamicObjectives: current.dynamicObjectives.filter((o) => o.id !== objectiveId),
            exercises: current.exercises.filter((ex) => ex.objectiveId !== objectiveId),
          }
        : current,
    );
  };
  // Edycja jednej linii przykładu danego celu (wym. 3.3): rodzic poprawia błędny
  // przykład AI przed publikacją. Zmiana brudzi formularz jak każda inna edycja.
  const mutateExampleLine = (objectiveId: string, lineIndex: number, value: string) => {
    markDirty();
    setExamplesForm((current) => {
      const base = current ?? {};
      const lines = [...(base[objectiveId] ?? [])];
      lines[lineIndex] = value;
      return { ...base, [objectiveId]: lines };
    });
  };

  const save = async () => {
    const base = baseSnapshot.current;
    if (!draft || !form || !base || busyRef.current || !dirty.current || base.versionId !== draft.id || calculationBlocked) return;
    if (form.title.trim().length === 0) {
      setError(messages.decks.titleIncomplete);
      return;
    }
    const snapshot: LessonEditorSnapshot = { ...base, form: structuredClone(form) };
    setBusyState(true);
    setError(null);
    setExerciseErrors({});
    try {
      // Revalidate every variant through the same domain immediately before saving.
      snapshot.form.exercises = await Promise.all(snapshot.form.exercises.map(async ex => ex.calculation
        ? applyCalculationPreview(ex, ex.calculation, await previewCalculation(ex.calculation!))
        : ex));
      const patch = toLessonDraftPatch(snapshot);
      // Przykłady serwer nadpisuje całością per cel; dokładamy aktualny stan,
      // bo serializacja ćwiczeń (lesson-editor-state) ich nie obejmuje.
      if (examplesForm) patch.examples = examplesForm;
      const interestsPatch = lessonThemesPatch(draft.interests, interestsForm);
      if (interestsPatch) patch.interests = interestsPatch;
      const saved = await run(() => parentClient.lessonDrafts.edit({
        lessonDraftId: snapshot.versionId,
        ...patch,
      }));
      baseSnapshot.current = createLessonSnapshot(saved, newKey);
      setForm(baseSnapshot.current.form);
      setExamplesForm(structuredClone(saved.examples ?? {}));
      setInterestsForm([...(saved.interests ?? [])]);
      dirty.current = false;
      setIsDirty(false);
      onEditorStateChange({ dirty: false, busy: true });
      setDeck((current) => (current ? { ...current, draft: saved, title: saved.title } : current));
      if (!(await load())) setError(messages.decks.savedRefreshFailed);
    } catch (cause) {
      if (cause instanceof ApiCallError && cause.code === "validation" && cause.details) {
        const parsed = cause.details as LessonExerciseErrors;
        const map: Record<number, string[]> = {};
        for (const entry of parsed.exercises ?? []) map[entry.index] = entry.errors;
        setExerciseErrors(map);
        setTab("exercises");
        setError(messages.errors.validation);
      } else if (cause instanceof ApiCallError && (cause.code === "conflict" || cause.code === "immutable")) {
        enterConflict(true);
        setError(messages.decks.conflictDetected);
      } else {
        // wygasła sesja: formularz zostaje, globalny handler otwiera logowanie nad edytorem
        setError(errorMessage(cause));
      }
    } finally {
      setBusyState(false);
    }
  };

  // Konflikt: porzuć lokalne poprawki i wczytaj aktualną wersję (wspólny,
  // minimalny mechanizm — odpowiednik „przejdź na aktualną wersję" słówek).
  const loadCurrentVersion = async () => {
    setBusyState(true);
    try {
      const result = await fetchRemote();
      dirty.current = false;
      setIsDirty(false);
      enterConflict(false);
      setDeck(result);
      const next = result.draft ?? result.published;
      if (next) {
        const snapshot = createLessonSnapshot(next, newKey);
        if (result.draft) baseSnapshot.current = snapshot;
        setForm(snapshot.form);
        setExamplesForm(structuredClone(next.examples ?? {}));
        setInterestsForm([...(next.interests ?? [])]);
      }
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyState(false);
    }
  };

  const publish = async () => {
    if (!draft || busy || isDirty || conflict || draft.exercises.length === 0 || draft.coverage.length > 0) return;
    setBusyState(true);
    setError(null);
    try {
      await run(() => parentClient.lessonDrafts.publish({
        lessonDraftId: draft.id,
        expectedEditNumber: draft.editNumber,
      }));
      dirty.current = false;
      setIsDirty(false);
      await load();
    } catch (cause) {
      // 409 pokrycia: odśwież, by pokazać aktualną listę braków z DTO;
      // zlecone przy publikacji audio odczyt pokaże jako generowane.
      setError(isMediaPendingError(cause) ? messages.decks.publishMediaPending : errorMessage(cause));
      await load();
    } finally {
      setBusyState(false);
    }
  };

  const startNewVersion = async () => {
    setBusyState(true);
    setError(null);
    try {
      await run(() => parentClient.lessons.draft({ deckId }));
      dirty.current = false;
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyState(false);
    }
  };

  const retry = async () => {
    if (!deck?.generation || busyRef.current || dirty.current || conflict) return;
    const runId = deck.generation.id;
    setBusyState(true);
    setError(null);
    try {
      await run(() => parentClient.generation.retry({ runId }));
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyState(false);
    }
  };

  const regenerate = async (objectiveId: string) => {
    if (!draft || busyRef.current || regenLock.current || generating || isDirty) return;
    regenLock.current = true;
    const count = regenCounts[objectiveId] ?? 4;
    setBusyState(true);
    setError(null);
    try {
      await run(() => parentClient.lessonDrafts.regenerate({
        lessonDraftId: draft.id,
        objectiveId,
        count,
        expectedEditNumber: draft.editNumber,
        clientRequestId: crypto.randomUUID(),
      }));
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      regenLock.current = false;
      setBusyState(false);
    }
  };

  const assignmentSettings = (childId: string): AssignmentTestSettings => {
    const existing = deck?.assignments.find((a) => a.childId === childId);
    return assignSettings[childId] ?? { testGoals: existing?.testGoals ?? null, mockTestTaskCount: existing?.mockTestTaskCount ?? 10 };
  };

  const assign = async (childId: string) => {
    setAssignError(childId, null);
    try {
      await run(() => parentClient.assignments.put({
        childId,
        deckId,
        testDate: (assignDates[childId] ?? deck?.assignments.find((a) => a.childId === childId)?.testDate) || null,
        ...assignmentSettings(childId),
      }));
      await load();
    } catch (cause) {
      setAssignError(childId, errorMessage(cause));
    }
  };

  const unassign = async (childId: string) => {
    setAssignError(childId, null);
    setUnassigningChildId(childId);
    try {
      await run(() => parentClient.assignments.remove({ childId, deckId }));
      await load();
    } catch (cause) {
      setAssignError(childId, errorMessage(cause));
    } finally {
      setUnassigningChildId(null);
    }
  };

  // jedno odtwarzanie naraz (target_audio, nagrania pytań i kart); odmontowanie edytora je zatrzymuje
  const playing = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { playing.current?.pause(); }, []);
  const playAsset = (assetId: string) => {
    playing.current?.pause();
    const audio = new Audio(`/api/v1/media/${assetId}`);
    playing.current = audio;
    void audio.play().catch(() => undefined);
  };

  // Źródło przykładów do wyświetlenia: edytowalny stan lokalny gdy jest szkic,
  // inaczej wartości z DTO (opublikowana wersja — podgląd tylko do odczytu).
  const examples = editable ? (examplesForm ?? draft?.examples ?? {}) : (deck?.published?.examples ?? {});
  const themes = editable ? (interestsForm ?? draft?.interests ?? []) : (deck?.published?.interests ?? []);
  const removeThemes = () => {
    markDirty();
    setInterestsForm([]);
  };
  const topic = catalog?.subjects.find((subject) => subject.id === active?.subjectId)?.topics
    .find((candidate) => candidate.id === active?.topicId && candidate.version === active?.topicVersion);
  // Cele i karty zestawów szkolnych pochodzą z DTO (temat dynamiczny), nie z katalogu.
  const objectiveMeta = (objectiveId: string) =>
    form?.dynamicObjectives?.find((objective) => objective.id === objectiveId)
    ?? active?.dynamicTopic?.objectives.find((objective) => objective.id === objectiveId)
    ?? topic?.objectives.find((objective) => objective.id === objectiveId);
  // Powody odrzuceń przy generowaniu (zliczenia bez danych dziecka) — rodzic widzi, czy dogenerować.
  const rejectedReasons = topRejectedReasons(active?.rejectedReasons);
  // Odrzucenia spoza wypisanych powodów (inna walidacja albo powody poza listą) — rodzic widzi całą skalę.
  const otherRejected = otherRejectedCount(active?.rejectedCount ?? 0, rejectedReasons);
  const indexByClientKey = new Map((form?.exercises ?? []).map((ex, index) => [ex.clientKey, index]));
  const groups = form ? groupExercisesByObjectiveAndStage(form.exercises, active?.objectiveIds ?? []) : [];

  // Okna potwierdzeń nie przeżywają edytora (powrót do listy, inna lekcja).
  useEffect(() => () => {
    for (const id of confirmIds.current) modals.close(id);
  }, []);

  // Błąd walidacji (400): pierwsza karta z błędem trafia na ekran.
  useEffect(() => {
    const indexes = Object.keys(exerciseErrors).map(Number);
    if (indexes.length === 0) return;
    const first = Math.min(...indexes);
    const frame = requestAnimationFrame(() => {
      document.querySelector(`[data-testid="exercise-${first}"]`)?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [exerciseErrors]);

  const confirmUnassign = (childId: string) => {
    confirmIds.current.push(modals.openConfirmModal({
      title: messages.decks.unassignTitle,
      centered: true,
      radius: "lg",
      children: <Text size="sm">{messages.decks.unassignConfirm}</Text>,
      labels: { confirm: messages.decks.unassign, cancel: messages.decks.archiveCancel },
      confirmProps: { color: "red", size: "md", "data-testid": "unassign-confirm" } as Record<string, unknown>,
      cancelProps: { size: "md", variant: "default", "data-autofocus": true } as Record<string, unknown>,
      onConfirm: runOnce(() => { void unassign(childId); }),
    }));
  };

  const archive = async () => {
    if (archiveBusy || busyRef.current) return;
    setArchiveBusy(true);
    setBusyState(true);
    setArchiveError(null);
    try {
      await run(() => parentClient.decks.archive({ deckId }));
      setBusyState(false);
      setArchiveOpen(false);
      onArchived();
    } catch (cause) {
      // wygasła sesja: logowanie otwiera globalny handler, okno archiwizacji nie zostaje pod spodem
      if (cause instanceof ApiCallError && cause.status === 401) setArchiveOpen(false);
      else setArchiveError(cause instanceof ApiCallError ? errorMessage(cause) : messages.lessons.archiveFailed);
    } finally {
      setArchiveBusy(false);
      if (busyRef.current) setBusyState(false);
    }
  };

  const confirmRemoveObjective = (objectiveId: string) => {
    confirmIds.current.push(modals.openConfirmModal({
      title: messages.lessons.removeDynamicObjectiveTitle,
      centered: true,
      radius: "lg",
      children: <Text size="sm" style={{ overflowWrap: "anywhere" }}>
        {messages.lessons.removeDynamicObjectiveConfirm.replace("{title}", objectiveMeta(objectiveId)?.titlePl ?? objectiveId)}
      </Text>,
      labels: { confirm: messages.lessons.removeDynamicObjective, cancel: messages.lessons.removeDynamicObjectiveCancel },
      confirmProps: { color: "red", size: "md", "data-testid": "dynamic-objective-remove-confirm" } as Record<string, unknown>,
      cancelProps: { size: "md", variant: "default", "data-autofocus": true } as Record<string, unknown>,
      onConfirm: runOnce(() => removeDynamicObjective(objectiveId)),
    }));
  };

  const subject = catalog?.subjects.find((candidate) => candidate.id === active?.subjectId);
  const subjectLine = [subject?.titlePl, topic?.titlePl ?? active?.dynamicTopic?.titlePl].filter(Boolean).join(" · ");
  const isDynamic = (objectiveId: string) => editable && (form?.dynamicObjectives?.some((o) => o.id === objectiveId) ?? false);
  const errorIndexes = new Set(Object.keys(exerciseErrors).map(Number));
  const stageKey = (objectiveId: string, stage: string) => `${objectiveId}:${stage}`;
  const errorsIn = (exercises: readonly EditableLessonExercise[]) =>
    exercises.filter((ex) => errorIndexes.has(indexByClientKey.get(ex.clientKey)!)).length;
  // Domyślnie (decyzja B): na telefonie pierwsza reguła rozwinięta, etapy zwinięte; na desktopie wszystko rozwinięte.
  const objectivesOpen = openObjectives ?? (compact ? groups.slice(0, 1).map((g) => g.objectiveId) : groups.map((g) => g.objectiveId));
  const stagesOpen = openStages ?? (compact ? [] : groups.flatMap((g) => g.stages.map((s) => stageKey(g.objectiveId, s.stage))));
  // Grupa z błędem walidacji zawsze rozwinięta.
  const forcedObjectives = groups.filter((g) => g.stages.some((s) => errorsIn(s.exercises) > 0)).map((g) => g.objectiveId);
  const forcedStages = groups.flatMap((g) => g.stages.filter((s) => errorsIn(s.exercises) > 0).map((s) => stageKey(g.objectiveId, s.stage)));
  const exerciseCount = form?.exercises.length ?? 0;
  const regenDisabled = busy || generating || isDirty;

  // klucz: identyfikator ćwiczenia (przeżywa zapis, który nadaje nowe klucze klienta), dla nowych — klucz klienta
  const toggleCard = (key: string) => setOpenCards((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const calculationControls = (ex: EditableLessonExercise): CalculationControls | null => {
    if (!ex.calculation) return null;
    const preview = calculationPreviews[ex.clientKey];
    const status = preview?.fingerprint !== JSON.stringify(ex.calculation) || preview?.status === "pending" ? "pending" : preview.status;
    return {
      input: (field) => calculationInputs[ex.clientKey + ":" + field],
      status,
      onChange: (calculation) => mutateCalculation(ex, calculation),
      onNumber: (field, text) => mutateCalculationNumber(ex, field, text),
      onKind: (kind) => {
        const common = { unit: ex.calculation!.unit, tolerance: ex.calculation!.tolerance, templateFamilyId: ex.calculation!.templateFamilyId };
        const calculation: CalculationSpec = kind === "scale_distance" ? { ...common, kind, params: { mapDistanceCm: 3, scaleDenominator: 25000 } }
          : kind === "height_difference" ? { ...common, kind, params: { upperHeightM: 400, lowerHeightM: 150 } }
          : { ...common, kind, params: { value: 1, fromUnit: "m" } };
        setCalculationInputs((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(ex.clientKey + ":"))));
        mutateCalculation(ex, calculation);
      },
    };
  };

  cardActionsRef.current = { toggle: toggleCard, mutate: mutateExercise, remove: removeExercise, play: playAsset };

  const exerciseCard = (ex: EditableLessonExercise) => {
    const index = indexByClientKey.get(ex.clientKey)!;
    const errors = exerciseErrors[index];
    const base = baseSnapshot.current?.form.exercises.find((b) => b.clientKey === ex.clientKey);
    // wersja tylko do odczytu (opublikowana, bez szkicu) nie ma bazy formularza — jej ćwiczenia są niezmienione
    const unchanged = !editable || (base !== undefined && !lessonExerciseChanged(ex, base));
    const changed = editable && !unchanged;
    // audio zapisanej wersji ćwiczenia: odtwarzane tylko bez zmian, a po zmianie zapowiada nowe media po zapisie
    const baseRevisionId = active?.exercises.find((e) => e.id === ex.id)?.revisionId ?? "";
    const savedAudio = active?.assets.find((a) => a.itemRevisionId === baseRevisionId && a.role === "target_audio") ?? null;
    const asset = unchanged ? savedAudio : null;
    // nagranie pytania: tak samo tylko dla ćwiczenia bez zmian od zapisu (zmiana tekstu lub tonu unieważnia nagranie)
    const promptAudio = unchanged ? active?.exercises.find((e) => e.id === ex.id)?.promptAudio ?? null : null;
    // nagranie zdania „Posłuchaj i wybierz”: tak samo tylko dla ćwiczenia bez zmian; bez „Nagraj ponownie” (nowa wersja lekcji ponawia)
    const sentenceAudio = unchanged ? active?.exercises.find((e) => e.id === ex.id)?.sentenceAudio ?? null : null;
    return (
      <LessonExerciseCard
        key={ex.clientKey}
        ex={ex}
        index={index}
        editable={editable}
        busy={busy}
        open={openCards.has(ex.id ?? ex.clientKey) || changed || errors !== undefined}
        changed={changed}
        hadAudio={savedAudio !== null}
        errors={errors}
        audio={asset ? { state: asset.state, assetId: asset.assetId ?? null } : null}
        voiceTones={active?.voiceTones}
        promptAudio={promptAudio}
        sentenceAudio={sentenceAudio}
        lessonDraftId={active?.id ?? ""}
        deckId={deckId}
        itemRevisionId={baseRevisionId}
        audioLocked={promptAudio !== null && isDirty}
        calculation={calculationControls(ex)}
        {...cardActions}
      />
    );
  };

  /**
   * Nagranie karty zagadnienia: tylko dla karty bez zmian od zapisu (tytuł, treść, ton i przykłady
   * zagadnienia — czytany tekst karty je obejmuje) i tylko gdy zapis ma dla niej wpis.
   */
  const cardAudio = (objectiveId: string, cardIndex: number) => {
    const entry = active?.cardAudio?.find((candidate) => candidate.objectiveId === objectiveId && candidate.cardIndex === cardIndex);
    if (!entry) return null;
    if (editable) {
      const saved = baseSnapshot.current?.form.dynamicObjectives?.find((o) => o.id === objectiveId)?.cards[cardIndex];
      const current = form?.dynamicObjectives?.find((o) => o.id === objectiveId)?.cards[cardIndex];
      const same = (a: EditableDynamicCard) => JSON.stringify([a.title, a.body, a.voiceTone ?? null]);
      if (!saved || !current || same(saved) !== same(current)) return null;
      if (JSON.stringify(examplesForm?.[objectiveId] ?? draft?.examples?.[objectiveId] ?? []) !== JSON.stringify(draft?.examples?.[objectiveId] ?? [])) return null;
    }
    return entry.audio;
  };

  /** Karta wyjaśnienia reguły z edytowalnymi przykładami (wym. 3.3) — na początku grupy reguły. */
  const explanation = (objectiveId: string) => {
    const dynamic = isDynamic(objectiveId);
    const lines = examples[objectiveId] ?? [];
    return (
      <Paper withBorder radius="md" p="sm" className="pp-lesson-explain" data-testid={`examples-${objectiveId}`}>
        <Stack gap="xs">
          <Text size="sm" fw={600}>{messages.lessons.examplesTitle}</Text>
          {dynamic && (
            <Group gap="xs" align="flex-end">
              <TextInput size="md" className="pp-lesson-grow" label={messages.lessons.dynamicObjectiveTitleLabel}
                data-testid={`dynamic-objective-title-${objectiveId}`} value={objectiveMeta(objectiveId)?.titlePl ?? ""} disabled={busy}
                onChange={(e) => mutateDynamicObjective(objectiveId, { titlePl: e.currentTarget.value })} />
              <Button size="md" variant="subtle" color="red" data-testid={`dynamic-objective-remove-${objectiveId}`} disabled={busy}
                onClick={() => confirmRemoveObjective(objectiveId)}>
                {messages.lessons.removeDynamicObjective}
              </Button>
            </Group>
          )}
          {objectiveMeta(objectiveId)?.cards.map((card, cardIndex) => {
            const audio = cardAudio(objectiveId, cardIndex);
            return (
            <article key={cardIndex} className="pp-lesson-card" data-testid={`lesson-card-preview-${objectiveId}`}>
              {audio && (
                <div className="pp-lesson-prompt-audio">
                  <PromptAudioControls audio={audio} target={{ kind: "card", objectiveId, cardIndex }} lessonDraftId={active?.id ?? ""} deckId={deckId}
                    canRegenerate={editable} locked={busy || isDirty} testId={`lesson-card-audio-${objectiveId}-${cardIndex}`} onPlay={playAsset}
                    targetLabel={cardAudioTargetLabel(cardIndex, card.title, objectiveMeta(objectiveId)?.titlePl)} />
                </div>
              )}
              {dynamic ? (
                <Stack gap="xs">
                  <TextInput size="md" data-testid={`dynamic-card-title-${objectiveId}-${cardIndex}`} value={card.title} disabled={busy}
                    aria-label={messages.lessons.dynamicCardTitleLabel}
                    onChange={(e) => {
                      const title = e.currentTarget.value;
                      mutateDynamicObjective(objectiveId, { cards: objectiveMeta(objectiveId)!.cards.map((c, ci) => (ci === cardIndex ? { ...c, title } : c)) });
                    }} />
                  <Textarea size="md" autosize minRows={2} data-testid={`dynamic-card-body-${objectiveId}-${cardIndex}`} value={card.body} disabled={busy}
                    aria-label={messages.lessons.dynamicCardBodyLabel}
                    onChange={(e) => {
                      const body = e.currentTarget.value;
                      mutateDynamicObjective(objectiveId, { cards: objectiveMeta(objectiveId)!.cards.map((c, ci) => (ci === cardIndex ? { ...c, body } : c)) });
                    }} />
                  {active?.voiceTones && (
                    <VoiceToneSelect value={(card as EditableDynamicCard).voiceTone} disabled={busy} hint={messages.lessons.voiceToneCardHint} whisper
                      styleEnabled={active.voiceTones.styleEnabled} testId={`dynamic-card-voice-tone-${objectiveId}-${cardIndex}`}
                      onChange={(voiceTone) => {
                        mutateDynamicObjective(objectiveId, { cards: objectiveMeta(objectiveId)!.cards.map((c, ci) => (ci === cardIndex ? { title: c.title, body: c.body, ...(voiceTone ? { voiceTone } : {}) } : c)) });
                      }} />
                  )}
                </Stack>
              ) : (
                <>
                  <Text fw={600}>{card.title}</Text>
                  <Text size="sm">{card.body.split("{{examples}}").join(" ").replace(/\s+/g, " ").trim()}</Text>
                </>
              )}
              <ul className="pp-lesson-examples">{lines.map((line, i) => line.trim() && <li key={i}>{line.trim()}</li>)}</ul>
            </article>
            );
          })}
          {!dynamic && <Text size="sm" className="pp-editor-muted">{messages.lessons.exampleHint}</Text>}
          {editable ? (
            <Stack gap="xs">
              {lines.map((line, i) => (
                <TextInput key={i} size="md" data-testid={`example-line-${objectiveId}-${i}`} value={line} disabled={busy}
                  aria-label={messages.lessons.exampleLineLabel.replace("{n}", String(i + 1))}
                  onChange={(e) => mutateExampleLine(objectiveId, i, e.currentTarget.value)} />
              ))}
              <Button size="md" variant="light" className="pp-lesson-start" data-testid={`example-add-${objectiveId}`}
                disabled={busy || lines.length >= 3} onClick={() => mutateExampleLine(objectiveId, lines.length, "")}>
                {messages.lessons.addExample}
              </Button>
            </Stack>
          ) : (
            <ul className="pp-lesson-examples">{lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
          )}
        </Stack>
      </Paper>
    );
  };

  const objectiveBadge = (objectiveId: string, exercises: readonly EditableLessonExercise[]) => {
    const errorCount = errorsIn(exercises);
    if (errorCount > 0) {
      return <span className="pp-status-badge" data-tone="danger">{messages.lessons.groupErrors[polishPlural(errorCount)]!.replace("{n}", String(errorCount))}</span>;
    }
    const gap = active?.coverage.find((candidate) => candidate.objectiveId === objectiveId);
    if (gap) {
      return (
        <span className="pp-status-badge" data-tone="warning">
          {messages.lessons.stageCoverage.replace("{stage}", messages.lessons.stages[gap.stage] ?? gap.stage)
            .replace("{actual}", String(gap.actual)).replace("{required}", String(gap.required))}
        </span>
      );
    }
    return active && active.coverage.length === 0 ? <span className="pp-status-badge" data-tone="success">{messages.lessons.coverageFull}</span> : null;
  };

  const objectiveGroups = form && groups.length > 0 && (
    <Accordion multiple order={3} variant="separated" radius="lg" chevronPosition="right" className="pp-lesson-objectives-list" data-testid="lesson-examples"
      value={[...new Set([...objectivesOpen, ...forcedObjectives])]} onChange={setOpenObjectives}>
      {groups.map((group) => {
        const all = group.stages.flatMap((s) => s.exercises);
        const count = all.length;
        // Rodzaj zagadnienia nadaje serwer (przedmiot z rodzajami, np. rozdział); edycja rodzica go nie zmienia.
        const kind = active?.dynamicTopic?.objectives.find((objective) => objective.id === group.objectiveId)?.kind;
        return (
          <Accordion.Item key={group.objectiveId} value={group.objectiveId} data-testid={`objective-group-${group.objectiveId}`}>
            <Group gap={4} wrap="nowrap" pr={compact ? 4 : "sm"}>
              <Accordion.Control className="pp-lesson-control">
                <Text fw={600} className="pp-lesson-objtitle">{objectiveMeta(group.objectiveId)?.titlePl ?? group.objectiveId}</Text>
                <Group gap={6} mt={4}>
                  <Text size="sm" className="pp-editor-muted">{messages.decks.itemCount.lesson![polishPlural(count)]!.replace("{n}", String(count))}</Text>
                  {kind && (
                    <span className="pp-status-badge" data-tone="neutral" data-testid={`objective-kind-${group.objectiveId}`}>
                      {messages.lessons.objectiveKind[kind] ?? kind}
                    </span>
                  )}
                  {objectiveBadge(group.objectiveId, all)}
                </Group>
              </Accordion.Control>
              {editable && (compact ? (
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <ActionIcon variant="subtle" color="gray" size={44} radius="md" aria-label={messages.lessons.objectiveActions} data-testid={`objective-menu-${group.objectiveId}`}>
                      <ParentIcon name="more-vertical" />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item leftSection={<ParentIcon name="refresh" />} data-testid={`regen-open-${group.objectiveId}`} disabled={regenDisabled}
                      onClick={() => setRegenTarget(group.objectiveId)}>
                      {messages.lessons.regenerateMenu}
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              ) : (
                <Button size="md" variant="subtle" leftSection={<ParentIcon name="refresh" />} data-testid={`regen-open-${group.objectiveId}`}
                  disabled={regenDisabled} onClick={() => setRegenTarget(group.objectiveId)}>
                  {messages.lessons.regenerateMenu}
                </Button>
              ))}
            </Group>
            <Accordion.Panel>
              <Stack gap="sm">
                {active?.objectiveIds.includes(group.objectiveId) && explanation(group.objectiveId)}
                {/* etapy bez animacji: rozwinięte razem z regułą (np. przez błąd) mierzyłyby wysokość ukrytej grupy */}
                <Accordion multiple order={4} variant="contained" radius="md" chevronPosition="right" transitionDuration={0}
                  value={[...new Set([...stagesOpen, ...forcedStages])]} onChange={setOpenStages}>
                  {group.stages.map((stageGroup) => {
                    const gap = active?.coverage.find((c) => c.objectiveId === group.objectiveId && c.stage === stageGroup.stage);
                    const stageErrors = errorsIn(stageGroup.exercises);
                    return (
                      <Accordion.Item key={stageGroup.stage} value={stageKey(group.objectiveId, stageGroup.stage)} data-testid={`stage-${group.objectiveId}-${stageGroup.stage}`}>
                        <Accordion.Control className="pp-lesson-control">
                          <Group gap="xs" wrap="nowrap">
                            <Text fw={600} size="sm" className="pp-editor-grow">{messages.lessons.stages[stageGroup.stage]}</Text>
                            {stageErrors > 0 && <span className="pp-status-badge" data-tone="danger">{stageErrors}</span>}
                            <span className="pp-status-badge" data-tone={gap ? "warning" : "neutral"}>
                              {gap ? messages.lessons.stageCount.replace("{actual}", String(gap.actual)).replace("{required}", String(gap.required)) : stageGroup.exercises.length}
                            </span>
                          </Group>
                        </Accordion.Control>
                        <Accordion.Panel>
                          {stageGroup.exercises.length === 0 ? (
                            <Text size="sm" className="pp-editor-muted">{messages.lessons.noExercisesInStage}</Text>
                          ) : (
                            <Stack gap="sm">
                              {groupCalculationFamilies(stageGroup.exercises).map((family) => (
                                <section key={family.key} className="pp-lesson-family" data-testid={family.familyId ? `calculation-family-${family.familyId}` : undefined}>
                                  {family.familyId && <Text size="sm" fw={600} mb={6}>{messages.lessons.calculationFamily.replace("{family}", family.familyId)}</Text>}
                                  <Stack gap="sm">{family.exercises.map(exerciseCard)}</Stack>
                                </section>
                              ))}
                            </Stack>
                          )}
                        </Accordion.Panel>
                      </Accordion.Item>
                    );
                  })}
                </Accordion>
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        );
      })}
    </Accordion>
  );

  const missingListenAudio = active ? missingListenAudioCount(active.exercises) : 0;
  const coverage = active && (
    <Paper withBorder radius="lg" p="md" data-testid="coverage-section">
      <Title order={2} fz="md" mb={6}>{messages.lessons.coverageTitle}</Title>
      {active.coverage.length === 0 ? (
        <Text size="sm" data-testid="coverage-ok">{messages.lessons.coverageOk}</Text>
      ) : (
        <ul className="pp-sup-list" data-testid="coverage-gaps">
          {active.coverage.map((gap, i) => (
            <li key={i} data-testid={`coverage-gap-${i}`}>
              <Text size="sm">
                {messages.lessons.coverageGap
                  .replace("{objective}", objectiveMeta(gap.objectiveId)?.titlePl ?? gap.objectiveId)
                  .replace("{stage}", messages.lessons.stages[gap.stage] ?? gap.stage)
                  .replace("{actual}", String(gap.actual))
                  .replace("{required}", String(gap.required))}
              </Text>
            </li>
          ))}
        </ul>
      )}
      {missingListenAudio > 0 && (
        <Text size="sm" mt="xs" data-testid="listen-missing-audio">
          {messages.lessons.listenChoiceMissingAudioCount.replace("{n}", String(missingListenAudio))}
        </Text>
      )}
    </Paper>
  );

  const budget = deck && (
    <Paper withBorder radius="lg" p="md">
      <DeckSessionTaskBudgetSettings
        deckId={deckId}
        value={sessionBudgetEdit ?? deck.sessionTaskBudget}
        edited={sessionBudgetEdit !== null}
        archived={deck.state === "archived"}
        busy={settingsBusy}
        error={settingsError}
        onChange={(value) => { setSettingsError(null); setSessionBudgetEdit(value); }}
        onBusyChange={setSettingsBusy}
        onSaved={(savedDeckId, saved) => {
          // deckId żądania (z chwili kliknięcia zapisu), nie bieżący widok:
          // nawigacja do innej lekcji w locie nie wbije cudzej wartości.
          setSessionBudgetEdit(null);
          setDeck((current) =>
            current && current.id === savedDeckId ? { ...current, sessionTaskBudget: saved } : current,
          );
        }}
        onError={setSettingsError}
      />
    </Paper>
  );

  const settings = deck && (compact ? (
    <Accordion variant="separated" radius="lg">
      <Accordion.Item value="settings">
        <Accordion.Control>
          <Text fw={600}>{messages.lessons.settingsTitle}</Text>
          <Text size="sm" className="pp-editor-muted">{messages.lessons.settingsSummary.replace("{n}", String(sessionBudgetEdit ?? deck.sessionTaskBudget))}</Text>
        </Accordion.Control>
        <Accordion.Panel>{budget}</Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  ) : (
    <>
      <Title order={2} fz="lg" mt="xs">{messages.lessons.settingsTitle}</Title>
      {budget}
    </>
  ));

  const publishBlocked = editable && (isDirty || (draft?.exercises.length ?? 0) === 0 || (draft?.coverage.length ?? 0) > 0);
  const showActionBar = editable || (deck?.state === "published" && !draft);
  const errorAlert = <EditorErrorText error={error ?? ""} />;

  const exercisesContent = (
    <Stack gap="md">
      {form && (
        <TextInput size="md" label={messages.decks.titleLabel} data-testid="editor-title" className="pp-editor-titlefield"
          value={form.title} disabled={!editable || busy}
          onChange={(e) => {
            const title = e.currentTarget.value;
            markDirty();
            setForm((current) => (current ? { ...current, title } : current));
          }} />
      )}
      {form && (
        <Group justify="space-between" align="baseline" mt="xs">
          <Title order={2} fz="lg">{messages.lessons.exercisesTitle}</Title>
          <Text size="sm" className="pp-editor-muted">{messages.decks.itemCount.lesson![polishPlural(exerciseCount)]!.replace("{n}", String(exerciseCount))}</Text>
        </Group>
      )}
      {objectiveGroups}
      {coverage}
      {settings}
    </Stack>
  );

  const childrenContent = deck?.published && (
    <Stack gap="md">
      {deck.state === "published" && (
        <>
          <Title order={2} fz="lg">{messages.decks.assignTitle}</Title>
          <EditorAssignments
            kind="lesson"
            childrenList={childrenList}
            assignments={deck.assignments}
            dates={assignDates}
            errors={assignErrors}
            unassigningChildId={unassigningChildId}
            settings={assignmentSettings}
            warning={(child, index) => child.canRead === false && (
              <Alert color="yellow" variant="light" data-testid={`non-reader-lesson-warning-${index}`}>
                {messages.decks.nonReaderLessonAssignment}
              </Alert>
            )}
            onDateChange={(childId, value) => setAssignDates((current) => ({ ...current, [childId]: value }))}
            onSettingsChange={(childId, value) => setAssignSettings((current) => ({ ...current, [childId]: value }))}
            onAssign={(childId) => void assign(childId)}
            onUnassign={confirmUnassign}
          />
        </>
      )}
      <LessonSupervisionPanel
        deckId={deckId}
        childrenList={childrenList}
        gradingModel={deck.grading.available ? (deck.grading.model ?? null) : null}
        onRegenerate={draft ? (objectiveId) => void regenerate(objectiveId) : undefined}
      />
    </Stack>
  );

  return (
    <div className="pp-editor pp-lesson-editor" data-testid="lesson-editor">
      <Button component="button" variant="subtle" size="md" px={4} className="pp-editor-back" data-testid="editor-back" onClick={onBack}
        leftSection={<ParentIcon name="chevron-left" />}>
        {messages.decks.backToList}
      </Button>
      <Group align="flex-start" gap="xs" wrap="nowrap" mt={4}>
        <Title order={1} fz={{ base: 22, sm: 26 }} className="pp-editor-title">{deck?.title ?? ""}</Title>
        {deck && deck.state !== "archived" && (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon ref={lessonMenuRef} variant="subtle" color="gray" size={44} radius="md" aria-label={messages.lessons.lessonActions} data-testid="lesson-menu">
                <ParentIcon name="more-vertical" />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item color="red" leftSection={<ParentIcon name="archive" />} data-testid="archive-lesson"
                disabled={busy || isDirty || conflict} onClick={() => { setArchiveError(null); setArchiveOpen(true); }}>
                {messages.lessons.archive}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
      <Group gap="xs" mt={6} mb={deck?.source ? 4 : "md"} className="pp-editor-meta">
        <span className="pp-status-badge" data-tone="info">{messages.lessons.kindLabel.lesson}</span>
        {deck?.state === "published" && <span className="pp-status-badge" data-tone="success" data-testid="publish-status">{messages.decks.published}</span>}
        {draft && deck?.state === "published" && <span className="pp-status-badge" data-tone="warning">{messages.decks.states.draft}</span>}
        {deck?.state === "archived" && <span className="pp-status-badge">{messages.decks.states.archived}</span>}
        {subjectLine && <Text size="sm" className="pp-editor-muted">{subjectLine}</Text>}
      </Group>
      {deck?.source && <LessonSourceNote source={deck.source} onOpen={onOpenSource} />}
      {themes.length > 0 && (
        <>
          <Group gap="xs" mb={editable ? 2 : "md"} align="center" data-testid="lesson-themes-line">
            <Text size="sm" className="pp-editor-muted">{messages.lessons.themesLine.replace("{themes}", () => themes.join(", "))}</Text>
            {editable && (
              <Button size="md" variant="subtle" data-testid="lesson-themes-remove" disabled={busy || conflict} onClick={removeThemes}>
                {messages.lessons.themesRemove}
              </Button>
            )}
          </Group>
          {editable && <Text size="xs" mb="md" className="pp-editor-muted" data-testid="lesson-themes-remove-hint">{messages.lessons.themesRemoveHint}</Text>}
        </>
      )}

      <Stack gap="md">
        {generating && (
          <Alert color="blue" variant="light" data-testid="generation-banner" icon={<Loader size="xs" />}>
            <Stack gap="xs" align="flex-start">
              <Text size="sm">{messages.lessons.generating}</Text>
              {deck?.generation?.state === "running" && (
                <>
                  <Text size="sm">{messages.lessons.stalledGenerationHint}</Text>
                  <Button size="md" variant="default" data-testid="retry-stalled-generation" leftSection={<ParentIcon name="refresh" />}
                    disabled={busy || isDirty || conflict} onClick={retry}>
                    {messages.lessons.retryGeneration}
                  </Button>
                </>
              )}
            </Stack>
          </Alert>
        )}
        {deck?.generation?.state === "failed" && (
          <Alert color="red" variant="light" data-testid="generation-failed">
            <Stack gap="xs" align="flex-start">
              <Text size="sm">{generationFailure}</Text>
              <Button size="md" variant="default" data-testid="generation-retry" leftSection={<ParentIcon name="refresh" />} onClick={retry}>
                {messages.lessons.retryGeneration}
              </Button>
            </Stack>
          </Alert>
        )}
        {gradingDisabled(deck) && <Alert color="gray" variant="light" data-testid="grading-disabled">{messages.lessons.gradingDisabled}</Alert>}
        {active && active.rejectedCount > 0 && (
          <Text size="sm" className="pp-editor-muted" data-testid="rejected-count">{messages.lessons.rejectedCount.replace("{n}", String(active.rejectedCount))}</Text>
        )}
        {rejectedReasons.length > 0 && (
          <div>
            <Text size="sm" className="pp-editor-muted" id="rejected-reasons-label" data-testid="rejected-reasons-label">{messages.lessons.rejectedReasonsLabel}</Text>
            <ul className="pp-lesson-rejected-reasons pp-editor-muted" aria-labelledby="rejected-reasons-label" data-testid="rejected-reasons">
              {rejectedReasons.map(({ reason, count }) => (
                <li key={reason}>{formatRejectedReason(messages.lessons.rejectedReason, reason, count)}</li>
              ))}
              {otherRejected > 0 && (
                <li data-testid="rejected-other">{messages.lessons.rejectedOtherReasons.replace("{n}", String(otherRejected))}</li>
              )}
            </ul>
          </div>
        )}
        {error && !showActionBar && errorAlert}

        {conflict && (
          <Paper withBorder radius="lg" p="md" className="pp-editor-conflict" data-testid="lesson-conflict-panel" aria-labelledby="lesson-conflict-title">
            <Stack gap="xs" align="flex-start">
              <Title order={2} fz="md" id="lesson-conflict-title" className="pp-editor-conflict-title">
                <ParentIcon name="alert-triangle" />
                {messages.decks.conflictTitle}
              </Title>
              <Text size="sm">{messages.decks.conflictDescription}</Text>
              <Button size="md" data-testid="conflict-load-remote" disabled={busy} onClick={loadCurrentVersion}>
                {messages.decks.conflictLoad}
              </Button>
            </Stack>
          </Paper>
        )}

        {childrenContent ? (
          <Tabs value={tab} onChange={(value) => setTab(value ?? "exercises")} keepMounted={false} styles={{ tab: { minHeight: 48 } }}>
            <Tabs.List grow={compact} mb="md">
              <Tabs.Tab value="exercises" data-testid="lesson-tab-exercises">{messages.lessons.tabExercises}</Tabs.Tab>
              <Tabs.Tab value="children" data-testid="lesson-tab-children">{messages.lessons.tabChildren}</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="exercises">
              {exercisesContent}
              <Text size="sm" mt="md" className="pp-editor-muted">{messages.lessons.assignmentsInChildrenTab}</Text>
            </Tabs.Panel>
            <Tabs.Panel value="children">{childrenContent}</Tabs.Panel>
          </Tabs>
        ) : exercisesContent}
      </Stack>

      <Modal
        opened={regenTarget !== null}
        onClose={() => setRegenTarget(null)}
        title={messages.lessons.regenerateTitle}
        centered
        radius="lg"
        fullScreen={compact}
      >
        {regenTarget && (
          <Stack gap="md">
            <Text size="sm" fw={600}>{objectiveMeta(regenTarget)?.titlePl ?? regenTarget}</Text>
            <NumberInput size="md" label={messages.lessons.regenerateCount} description={messages.lessons.regenerateHint}
              data-testid={`regen-count-${regenTarget}`} min={1} max={60} allowDecimal={false} allowNegative={false} clampBehavior="none" maw={200}
              value={regenCounts[regenTarget] ?? 4}
              onChange={(value) => setRegenCounts((current) => ({ ...current, [regenTarget]: value === "" ? Number.NaN : Number(value) }))} />
            <Group justify="flex-end" gap="sm">
              <Button size="md" variant="default" onClick={() => setRegenTarget(null)}>{messages.lessons.regenerateCancel}</Button>
              <Button size="md" data-testid={`regen-submit-${regenTarget}`} disabled={regenDisabled || !regenCountValid(regenCounts[regenTarget] ?? 4)}
                onClick={() => {
                  const objectiveId = regenTarget;
                  setRegenTarget(null);
                  void regenerate(objectiveId);
                }}>
                {messages.lessons.regenerateSubmit}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      <ArchiveLessonDialog
        lesson={archiveOpen && deck ? { title: deck.title } : null}
        busy={archiveBusy}
        error={archiveError}
        onCancel={() => setArchiveOpen(false)}
        onConfirm={() => void archive()}
        onClosed={() => lessonMenuRef.current?.focus()}
      />

      {showActionBar && (
        <EditorActionBar
          error={error}
          blockedReason={publishBlocked
            ? (isDirty
              ? `${messages.decks.unsavedChanges} · ${messages.lessons.saveBeforePublish}`
              : (draft?.exercises.length ?? 0) === 0 ? messages.lessons.emptyLesson : messages.lessons.publishBlockedCoverage)
            : null}
          editable={editable}
          isDirty={isDirty}
          busy={busy}
          testIds={{ save: "save-lesson", publish: "publish-lesson" }}
          saveDisabled={busy || conflict || calculationBlocked}
          publishDisabled={busy || isDirty || conflict || (draft?.exercises.length ?? 0) === 0 || (draft?.coverage.length ?? 0) > 0}
          onSave={() => void save()}
          onPublish={() => void publish()}
          onNewVersion={() => void startNewVersion()}
        />
      )}
    </div>
  );
}
