"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Alert, Anchor, Button, Checkbox, Group, Loader, NativeSelect, NumberInput, Paper, SimpleGrid, Stack, Text, TextInput, Textarea, Title } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { messages, mergeChildInterests, normalizeChildInterest, MAX_CHILD_INTERESTS, MAX_SCHOOL_MATERIAL_LENGTH, MAX_SCHOOL_SUBJECT_TITLE_LENGTH, MAX_SCHOOL_TOPIC_TITLE_LENGTH, type LessonCommand, type MaterialLessonCommand, type SchoolLessonCommand, type SubjectCatalogDto } from "@learning/contracts";
import { callParent, errorMessage, parentClient } from "../api";
import { interestsError, parseInterestsInput } from "../children-forms";
import { InterestsTagsInput, useInterestNotice } from "../InterestsTagsInput";
import { readLessonAcceptance } from "../generation-request";
import { ParentIcon } from "../ParentIcon";
import { routePath } from "../parent-routes";
import { plainClick } from "../plain-click";
import { httpStatusOf, orpc } from "../query-client";
import { classifyCreateFailure, isFreshSourceRefresh, type SourceRefreshOutcome } from "../sources/source-refresh";
import type { EditorLeaveState } from "../useParentLeaveGuard";
import "./lesson-panels.css";
import "../sources/sources-panel.css";

const MATERIAL_MAX = 8000;
const POOL_MIN = 20;
const POOL_MAX = 120;
/** Zestawy tworzone z materiału (szkoła, rozdział) mają wyższy limit puli w kontrakcie (160). */
const MATERIAL_POOL_MAX = 160;
/**
 * Limit czasu polecenia utworzenia lekcji (serwer tylko przyjmuje je do kolejki).
 * Zawieszone żądanie nie trzyma blokady wyjścia bez końca: po limicie wynik jest
 * niepewny, a ponowienie wysyła to samo polecenie (ten sam clientRequestId).
 */
const CREATE_TIMEOUT_MS = 30_000;

/** Domyślna wielkość puli: większa z 60 i 12 × liczba reguł (requirements 2.1). */
export function defaultPoolSize(objectiveCount: number): number {
  const raw = Math.max(60, 12 * objectiveCount);
  return Math.min(POOL_MAX, Math.max(POOL_MIN, raw));
}

export interface NewLessonValues {
  subjectId: string;
  topicId: string;
  objectiveIds: string[];
  material: string;
  instruction: string;
  poolSize: number | string;
  poolSizeTouched: boolean;
  /** Nazwa przedmiotu od rodzica — tylko zestawy szkolne. */
  schoolSubjectName: string;
  /** Tytuł tematu (szkoła) albo rozdziału (przedmiot o stałym tytule) wpisany przez rodzica. */
  topicTitle: string;
  /** Tematy zdań (gramatyka) — wpisane albo wstawione przez rodzica; formularz nie wypełnia ich sam. */
  interests: string[];
}

/**
 * Przedmioty do wyboru w formularzu. Lekcja ze źródła ma tekst ze źródła,
 * więc tylko przedmioty tworzone z materiału (polecenia katalogowe nie
 * przyjmują `sourceMaterialId`).
 */
export function lessonSubjects(catalog: SubjectCatalogDto | undefined, fromSource = false): SubjectCatalogDto["subjects"] {
  const subjects = catalog?.subjects ?? [];
  return fromSource ? subjects.filter((subject) => subject.creation === "material") : subjects;
}

/** Wybór startowy formularza: przedmiot wskazany w adresie i tytuł tematu (tytuł źródła). */
export interface LessonPreset {
  subjectId?: string | undefined;
  topicTitle?: string | undefined;
  fromSource?: boolean | undefined;
}

/**
 * Wartości startowe z katalogu: wskazany (albo pierwszy dostępny) przedmiot,
 * pierwszy temat, wszystkie jego reguły; ze źródła — tytuł źródła jako temat.
 */
export function initialLessonValues(catalog: SubjectCatalogDto | undefined, preset: LessonPreset = {}): NewLessonValues {
  const subjects = lessonSubjects(catalog, preset.fromSource);
  const subject = subjects.find((s) => s.id === preset.subjectId) ?? subjects[0];
  const topic = subject?.topics[0];
  const objectiveIds = topic?.objectives.map((o) => o.id) ?? [];
  return {
    subjectId: subject?.id ?? "",
    topicId: topic?.id ?? "",
    objectiveIds,
    material: "",
    instruction: "",
    poolSize: defaultPoolSize(objectiveIds.length),
    poolSizeTouched: false,
    schoolSubjectName: "",
    topicTitle: (preset.topicTitle ?? "").trim().slice(0, MAX_SCHOOL_TOPIC_TITLE_LENGTH),
    interests: [],
  };
}

function acceptsInterests(catalog: SubjectCatalogDto | undefined, subjectId: string): boolean {
  // tematy przyjmuje tylko polecenie katalogowe (polecenia szkolne i z materiału są `strict`)
  return lessonPathOf(catalog, subjectId) === "catalog" && catalog?.subjects.find((s) => s.id === subjectId)?.acceptsInterests === true;
}

/**
 * Tematy zdań do polecenia: tylko dla przedmiotu, który je przyjmuje (`acceptsInterests`),
 * i tylko gdy lista nie jest pusta. Po zmianie przedmiotu na inny lista nie jest wysyłana.
 */
export function lessonInterestsOf(values: NewLessonValues, catalog: SubjectCatalogDto | undefined): string[] | undefined {
  if (!acceptsInterests(catalog, values.subjectId)) return undefined;
  const interests = parseInterestsInput(values.interests);
  return interests.length > 0 ? interests : undefined;
}

/** Komunikat błędu listy tematów (niepoprawny wpis) dla przedmiotu, który je przyjmuje; inaczej `null`. */
function lessonInterestsError(values: NewLessonValues, catalog: SubjectCatalogDto | undefined): string | null {
  return acceptsInterests(catalog, values.subjectId) ? interestsError(parseInterestsInput(values.interests)) : null;
}

export type PendingLesson =
  | { kind: "catalog"; command: LessonCommand }
  | { kind: "school"; command: SchoolLessonCommand }
  | { kind: "material"; command: MaterialLessonCommand };

/**
 * Ścieżka tworzenia lekcji wybranego przedmiotu, wg katalogu: `catalog` — temat
 * i reguły z katalogu, `school` — z materiału z nazwą przedmiotu od rodzica,
 * `material` — z materiału dla przedmiotu o stałym tytule (np. rozdział angielskiego).
 */
export type LessonPath = PendingLesson["kind"];

export function lessonPathOf(catalog: SubjectCatalogDto | undefined, subjectId: string): LessonPath {
  const subject = catalog?.subjects.find((s) => s.id === subjectId);
  if (subject?.creation !== "material") return "catalog";
  return subject.subjectTitleRequired ? "school" : "material";
}

/**
 * Brak możliwości wysłania (przycisk wyłączony). Komunikat walidacji przy
 * kliknięciu daje `validationError` — wyłączony przycisk zwykle go uprzedza.
 * Ze źródła (`fromSource`) tekst nie pochodzi z pola materiału.
 */
export function canSubmitLesson(values: NewLessonValues, catalog: SubjectCatalogDto | undefined, fromSource = false): boolean {
  const path = lessonPathOf(catalog, values.subjectId);
  const pool = values.poolSize;
  const poolValid = typeof pool === "number" && Number.isInteger(pool) && pool >= POOL_MIN && pool <= (path === "catalog" ? POOL_MAX : MATERIAL_POOL_MAX);
  const material = values.material.trim().length;
  if (!poolValid || lessonInterestsError(values, catalog) !== null) return false;
  if (path !== "catalog") {
    const subjectName = values.schoolSubjectName.trim().length;
    const topicName = values.topicTitle.trim().length;
    return (path === "material" || (subjectName > 0 && subjectName <= MAX_SCHOOL_SUBJECT_TITLE_LENGTH))
      && topicName > 0 && topicName <= MAX_SCHOOL_TOPIC_TITLE_LENGTH
      && (fromSource || (material > 0 && material <= MAX_SCHOOL_MATERIAL_LENGTH));
  }
  // polecenie katalogowe nie przyjmuje źródła — formularz ze źródłem nie oferuje takich przedmiotów
  if (fromSource) return false;
  const subject = catalog?.subjects.find((s) => s.id === values.subjectId);
  const topic = subject?.topics.find((t) => t.id === values.topicId);
  return topic !== undefined && values.objectiveIds.length > 0 && material > 0 && material <= MATERIAL_MAX;
}

function validationError(values: NewLessonValues, path: LessonPath, fromSource: boolean, catalog: SubjectCatalogDto | undefined): string | null {
  const material = values.material.trim().length;
  const interests = lessonInterestsError(values, catalog);
  if (interests) return interests;
  if (path !== "catalog") {
    if ((path === "school" && values.schoolSubjectName.trim().length === 0) || values.topicTitle.trim().length === 0) return messages.lessons.schoolMaterialRequired;
    if (!fromSource && (material === 0 || material > MAX_SCHOOL_MATERIAL_LENGTH)) return messages.lessons.schoolMaterialRequired;
    return null;
  }
  if (values.objectiveIds.length === 0) return messages.lessons.objectivesRequired;
  if (material === 0 || material > MATERIAL_MAX) return messages.lessons.materialRequired;
  return null;
}

/** Źródło, z którego powstaje polecenie: identyfikator i rewizja treści wyświetlonego podglądu. */
export interface CommandSource {
  id: string;
  bodyRevision: number;
}

/**
 * Polecenie utworzenia lekcji z nowymi identyfikatorami zestawu i żądania.
 * Ze źródła polecenie niesie odwołanie zamiast tekstu (`sourceMaterialId`) i
 * rewizję treści podglądu (`expectedSourceRevision`) — serwer kopiuje tekst
 * źródła tylko wtedy, gdy to wciąż ten, który rodzic widział (kontrakt:
 * dokładnie jedno z `material` / `sourceMaterialId`).
 */
export function buildCommand(values: NewLessonValues, path: LessonPath, source?: CommandSource, interests?: string[]): PendingLesson {
  const instruction = values.instruction.trim();
  const shared = {
    deckId: crypto.randomUUID(),
    ...(instruction ? { instruction } : {}),
    poolSize: Number(values.poolSize),
    clientRequestId: crypto.randomUUID(),
  };
  const text = source !== undefined
    ? { sourceMaterialId: source.id, expectedSourceRevision: source.bodyRevision }
    : { material: values.material.trim() };
  switch (path) {
    case "school":
      return { kind: "school", command: { ...shared, ...text, subjectTitlePl: values.schoolSubjectName.trim(), topicTitlePl: values.topicTitle.trim() } };
    case "material":
      return { kind: "material", command: { ...shared, ...text, subjectId: values.subjectId, topicTitlePl: values.topicTitle.trim() } };
    case "catalog":
      return { kind: "catalog", command: { ...shared, material: values.material.trim(), subjectId: values.subjectId, topicId: values.topicId, objectiveIds: [...values.objectiveIds], ...(interests && interests.length > 0 ? { interests: [...interests] } : {}) } };
  }
}

/**
 * Formularz nowej lekcji: przedmiot → temat (z katalogu) → reguły (domyślnie
 * wszystkie) → materiał (licznik, limit 8000) → instrukcja → wielkość puli;
 * przedmiot szkolny zamiast tematu i reguł ma nazwy wpisane przez rodzica,
 * a przedmiot o stałym tytule (rozdział angielskiego) — tylko tytuł rozdziału.
 * Wysyłka z kluczem idempotencji: niepewna odpowiedź zostawia polecenie do
 * ponowienia (to samo `deckId`), także po zmianie przedmiotu (W15). Wpisane
 * dane chroni leave guard; 401 obsługuje globalny handler (przy wpisanych
 * danych logowanie w oknie nad formularzem).
 *
 * Ze źródła (`source`, design 2026-10-30 §3.4) zamiast pola materiału jest
 * tytuł i podgląd tekstu źródła (tylko do odczytu) z linkiem „Zmień źródło”
 * (lista źródeł), przycisk u góry wraca do strony źródła („Wróć do źródła”),
 * a polecenie niesie `sourceMaterialId` z rewizją treści podglądu; do wyboru
 * są tylko przedmioty tworzone z materiału. Gdy tekst źródła zmieniono w innym
 * oknie, serwer odrzuca polecenie (409): formularz odświeża podgląd
 * (`onSourceChanged`), pokazuje komunikat, a ponowne „Utwórz lekcję” jest
 * potwierdzeniem nowego tekstu. Tworzenie czeka na udane odświeżenie z nową
 * rewizją treści: nieudane pokazuje komunikat z „Spróbuj ponownie”, a 404 —
 * stan usuniętego źródła.
 */
export default function NewLessonForm({
  onCreated,
  onCancel,
  registerEditorState,
  source,
  initialSubjectId,
  onOpenSource,
  onSourceChanged,
}: {
  onCreated: (deckId: string) => void;
  onCancel: () => void;
  registerEditorState: (state: EditorLeaveState) => void;
  /**
   * Źródło, z którego powstaje lekcja: tekst do podglądu i jego rewizja treści
   * (serwer kopiuje tekst przy tworzeniu, jeśli rewizja wciąż się zgadza).
   */
  source?: { id: string; title: string; body: string; bodyRevision: number } | undefined;
  /** Przedmiot wybrany od startu (np. z przycisku na stronie źródła). */
  initialSubjectId?: string | undefined;
  /**
   * Tryb źródła: strona źródła (`sourceId` — „Wróć do źródła”) albo lista źródeł
   * (`null` — „Zmień źródło” i powrót po usunięciu źródła w innym oknie).
   */
  onOpenSource?: ((sourceId: string | null) => void) | undefined;
  /**
   * Tryb źródła: ponowny odczyt źródła po konflikcie rewizji (odświeża podgląd
   * i rewizję w `source`); wynik mówi, czy odczyt się udał.
   */
  onSourceChanged?: (() => Promise<SourceRefreshOutcome>) | undefined;
}) {
  const fromSource = source !== undefined;
  const catalogQuery = useQuery(orpc.lessonCatalog.get.queryOptions());
  const catalog = catalogQuery.data;
  // wspólna pamięć podręczna z ParentApp; zainteresowania dzieci tylko do przycisków „Wstaw…”
  const childrenQuery = useQuery(orpc.children.list.queryOptions());
  const [interestNotice, setInterestNotice] = useInterestNotice();
  const sourceTitle = source?.title;
  const form = useForm<NewLessonValues>({
    mode: "controlled",
    // Katalog już w pamięci podręcznej (lub wstawiony) ustawia wartości od pierwszego renderu.
    initialValues: initialLessonValues(catalog, { subjectId: initialSubjectId, topicTitle: sourceTitle, fromSource }),
    // komunikat wysyłki (np. niepewne utworzenie) zostaje do następnego kliknięcia, także po zmianie przedmiotu
    clearInputErrorOnChange: false,
  });
  const pending = useRef<PendingLesson | null>(null);
  const creatingRef = useRef(false);
  const mounted = useRef(false);
  // źródło usunięte w innym oknie (404 przy tworzeniu): link prowadzi do listy źródeł, tworzenie wyłączone
  const [sourceMissing, setSourceMissing] = useState(false);
  // podgląd odświeża się po konflikcie rewizji źródła — do udanego odświeżenia tworzenie jest wyłączone
  const [refreshingSource, setRefreshingSource] = useState(false);
  // odświeżenie podglądu się nie udało: komunikat z „Spróbuj ponownie”, tworzenie nadal wyłączone
  const [sourceRefreshFailed, setSourceRefreshFailed] = useState(false);
  // rewizja treści odrzucona przez serwer (409): podgląd z tą rewizją jest nieaktualny,
  // więc tworzenie czeka, aż `source` przyniesie nową
  const [staleSourceRevision, setStaleSourceRevision] = useState<number | null>(null);
  const sourceOutdated = staleSourceRevision !== null && source?.bodyRevision === staleSourceRevision;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Katalog ustala wartości startowe — formularz bez zmian rodzica nie jest „brudny”.
  const { initialize } = form;
  useEffect(() => {
    if (catalog) initialize(initialLessonValues(catalog, { subjectId: initialSubjectId, topicTitle: sourceTitle, fromSource }));
  }, [catalog, initialize, initialSubjectId, sourceTitle, fromSource]);

  const create = useMutation({
    mutationFn: (lesson: PendingLesson) => callParent(() => {
      const options = { signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) };
      switch (lesson.kind) {
        case "school":
          return parentClient.lessons.createSchool(lesson.command, options);
        case "material":
          return parentClient.lessons.createFromMaterial(lesson.command, options);
        case "catalog":
          return parentClient.lessons.create(lesson.command, options);
      }
    }),
  });
  const creating = create.isPending;

  const values = form.getValues();
  const path = lessonPathOf(catalog, values.subjectId);
  const fromMaterial = path !== "catalog";
  const subjects = lessonSubjects(catalog, fromSource);
  const subject = catalog?.subjects.find((s) => s.id === values.subjectId);
  const topic = subject?.topics.find((t) => t.id === values.topicId);
  const materialMax = fromMaterial ? MAX_SCHOOL_MATERIAL_LENGTH : MATERIAL_MAX;
  const hasPending = pending.current !== null;
  const dirty = form.isDirty() || hasPending;

  // W trakcie wysyłania polecenia wyjście jest zablokowane (jak zapis w edytorach):
  // odpowiedź otwiera utworzoną lekcję, więc nawigacja w tej chwili by się z nią ścigała.
  useEffect(() => {
    registerEditorState({ dirty, busy: creating });
  }, [registerEditorState, dirty, creating]);
  useEffect(() => () => registerEditorState({ dirty: false, busy: false }), [registerEditorState]);

  const setObjectives = (objectiveIds: string[]) => {
    form.setValues((current) => ({
      objectiveIds,
      // domyślna pula podąża za liczbą reguł, dopóki rodzic jej ręcznie nie zmieni
      ...(current.poolSizeTouched ? {} : { poolSize: defaultPoolSize(objectiveIds.length) }),
    }));
  };
  const chooseSubject = (id: string) => {
    const firstTopic = catalog?.subjects.find((s) => s.id === id)?.topics[0];
    form.setFieldValue("subjectId", id);
    form.setFieldValue("topicId", firstTopic?.id ?? "");
    setObjectives(firstTopic?.objectives.map((o) => o.id) ?? []);
  };
  const chooseTopic = (id: string) => {
    form.setFieldValue("topicId", id);
    setObjectives(subject?.topics.find((t) => t.id === id)?.objectives.map((o) => o.id) ?? []);
  };
  const toggleObjective = (id: string) => {
    const current = form.getValues().objectiveIds;
    setObjectives(current.includes(id) ? current.filter((o) => o !== id) : [...current, id]);
  };

  /**
   * Ponowny odczyt źródła po konflikcie rewizji. Tworzenie wraca dopiero po
   * udanym odczycie z rewizją treści inną niż odrzucona (`stale`); nieudany
   * odczyt zostawia komunikat z „Spróbuj ponownie”, a 404 — stan usuniętego źródła.
   */
  const refreshSource = async (stale: number | null): Promise<void> => {
    setRefreshingSource(true);
    let outcome: SourceRefreshOutcome = { status: "failed" };
    try {
      if (onSourceChanged) outcome = await onSourceChanged();
    } catch {
      // odczyt zgłoszony wyjątkiem to także nieudane odświeżenie
    }
    if (!mounted.current) return;
    setRefreshingSource(false);
    if (outcome.status === "missing") {
      setSourceRefreshFailed(false);
      setSourceMissing(true);
      form.setFieldError("submit", messages.sources.notFound);
    } else if (isFreshSourceRefresh(outcome, stale)) {
      setSourceRefreshFailed(false);
      form.setFieldError("submit", messages.sources.changedBeforeCreate);
    } else {
      setSourceRefreshFailed(true);
      form.setFieldError("submit", messages.sources.refreshFailed);
    }
  };

  const submit = async (): Promise<void> => {
    if (creatingRef.current) return;
    let lesson = pending.current;
    if (!lesson) {
      const invalid = validationError(values, path, fromSource, catalog);
      if (invalid) {
        form.setFieldError("submit", invalid);
        return;
      }
      lesson = buildCommand(values, path, source, lessonInterestsOf(values, catalog));
      pending.current = lesson;
    }
    creatingRef.current = true;
    form.clearFieldError("submit");
    try {
      const acceptance = readLessonAcceptance(await create.mutateAsync(lesson));
      if (!acceptance) {
        if (mounted.current) form.setFieldError("submit", messages.lessons.createUncertain);
        return;
      }
      pending.current = null;
      if (!mounted.current) return;
      // utworzona lekcja nie jest już niezapisaną zmianą — przejście do edytora nie pyta o wyjście
      registerEditorState({ dirty: false, busy: false });
      onCreated(acceptance.deckId);
    } catch (cause) {
      const failure = classifyCreateFailure(cause, fromSource);
      if (failure === "uncertain") {
        if (mounted.current) form.setFieldError("submit", messages.lessons.createUncertain);
        return;
      }
      // Odpowiedź ostateczna: serwer sprawdza wcześniejsze polecenie z tym kluczem przed
      // odczytem źródła, więc zestaw nie powstał — następna wysyłka buduje nowe polecenie.
      pending.current = null;
      if (failure === "source-missing") {
        // źródło usunięto w innym oknie — bez ponowienia
        if (mounted.current) {
          setSourceMissing(true);
          form.setFieldError("submit", messages.sources.notFound);
        }
      } else if (failure === "source-changed") {
        // Tekst źródła zmieniono w innym oknie po wyświetleniu podglądu: podgląd odświeża
        // się do bieżącej wersji, a ponowne „Utwórz lekcję” potwierdza nowy tekst.
        const rejected = lesson.kind === "catalog" ? undefined : lesson.command.expectedSourceRevision;
        const stale = rejected ?? source?.bodyRevision ?? null;
        if (mounted.current) {
          form.setFieldError("submit", messages.sources.changedBeforeCreate);
          setStaleSourceRevision(stale);
          await refreshSource(stale);
        }
      } else if (httpStatusOf(cause) !== 401 && mounted.current) {
        // 401: logowanie otwiera globalny handler, formularz zostaje
        form.setFieldError("submit", errorMessage(cause));
      }
    } finally {
      creatingRef.current = false;
    }
  };

  const showThemes = acceptsInterests(catalog, values.subjectId);
  // ponowienie wysyła to samo polecenie, więc pole tematów blokuje się jak pozostałe pola
  const themesLocked = creating || hasPending;
  const themesPresent = new Set(values.interests.map((entry) => normalizeChildInterest(entry).toLowerCase()));
  const themesFull = values.interests.length >= MAX_CHILD_INTERESTS;
  const childrenWithInterests = (childrenQuery.data ?? []).filter((child) => child.interests.length > 0);
  const insertThemes = (interests: string[]) => {
    const merged = mergeChildInterests(form.getValues().interests, interests);
    const kept = new Set(merged.map((entry) => entry.toLowerCase()));
    // limit 5 uciął część tematów dziecka: rodzic ma to zobaczyć, a nie tylko mniej tagów
    setInterestNotice(interests.some((entry) => !kept.has(normalizeChildInterest(entry).toLowerCase())) ? "limit" : null);
    form.setFieldValue("interests", merged);
  };
  const generationService = catalog?.generationService;
  const themesService = generationService
    ? messages.lessons.themesService.replace("{service}", () => generationService)
    : messages.lessons.themesServiceUnknown;

  const submitError = form.errors.submit;
  const counterTemplate = fromMaterial ? messages.lessons.schoolMaterialCounter : messages.lessons.materialCounter;

  // „Zmień źródło” prowadzi do listy źródeł (wybór innego), a przycisk u góry — z powrotem
  // na stronę źródła; po usunięciu źródła w innym oknie oba prowadzą do listy.
  const changeSourceHref = routePath({ section: "sources" });
  const changeSource = (event: MouseEvent) => {
    if (!plainClick(event) || !onOpenSource) return;
    event.preventDefault();
    onOpenSource(null);
  };
  const back = source === undefined
    ? { label: messages.decks.backToList, onClick: onCancel }
    : sourceMissing
      ? { label: messages.sources.backToList, onClick: () => onOpenSource?.(null) }
      : { label: messages.sources.backToSource, onClick: () => onOpenSource?.(source.id) };

  return (
    <Stack gap="md" data-testid="new-lesson-form" className="pp-editor pp-lesson-new">
      <div>
        <Button variant="subtle" size="md" px={4} className="pp-editor-back" data-testid="new-lesson-cancel" onClick={back.onClick}
          leftSection={<ParentIcon name="chevron-left" />}>
          {back.label}
        </Button>
        <Title order={1} fz={{ base: 22, sm: 26 }} mt={6}>{messages.lessons.newLessonTitle}</Title>
      </div>

      {catalogQuery.isError && (
        <Alert color="red" variant="light" role="alert" data-testid="lesson-catalog-error">
          <Stack gap="sm" align="flex-start">
            <Text size="sm">{errorMessage(catalogQuery.error)}</Text>
            <Button size="md" variant="light" color="red" onClick={() => void catalogQuery.refetch()}>{messages.parentShell.retry}</Button>
          </Stack>
        </Alert>
      )}
      {catalogQuery.isPending && (
        <Group gap="sm" role="status"><Loader size="sm" /><Text>{messages.parentShell.loading}</Text></Group>
      )}

      {catalog && (
        <Paper withBorder radius="lg" p={{ base: "md", sm: "lg" }}>
          <Stack gap="md">
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" verticalSpacing="md">
              <NativeSelect
                size="md"
                id="lesson-subject"
                label={messages.lessons.subjectLabel}
                data-testid="lesson-subject"
                value={values.subjectId}
                disabled={creating}
                onChange={(e) => chooseSubject(e.currentTarget.value)}
                data={subjects.map((s) => ({ value: s.id, label: s.titlePl }))}
              />
              {path === "catalog" && (
                <NativeSelect
                  size="md"
                  id="lesson-topic"
                  label={messages.lessons.topicLabel}
                  data-testid="lesson-topic"
                  value={values.topicId}
                  disabled={creating}
                  onChange={(e) => chooseTopic(e.currentTarget.value)}
                  data={(subject?.topics ?? []).map((t) => ({ value: t.id, label: t.titlePl }))}
                />
              )}
              {path === "school" && (
                <>
                  <TextInput size="md" id="school-subject-name" label={messages.lessons.schoolSubjectNameLabel} data-testid="school-subject-name"
                    maxLength={MAX_SCHOOL_SUBJECT_TITLE_LENGTH} disabled={creating} {...form.getInputProps("schoolSubjectName")} />
                  <TextInput size="md" id="school-topic-name" label={messages.lessons.schoolTopicNameLabel} data-testid="school-topic-name"
                    maxLength={MAX_SCHOOL_TOPIC_TITLE_LENGTH} disabled={creating} {...form.getInputProps("topicTitle")} />
                </>
              )}
              {path === "material" && (
                <TextInput size="md" id="material-topic-name" label={messages.lessons.chapterTopicLabel} data-testid="material-topic-name"
                  maxLength={MAX_SCHOOL_TOPIC_TITLE_LENGTH} disabled={creating} {...form.getInputProps("topicTitle")} />
              )}
            </SimpleGrid>

            {fromMaterial ? (
              <Text size="sm" className="pp-editor-muted" data-testid="school-objectives-auto">{messages.lessons.schoolObjectivesAuto}</Text>
            ) : (
              <fieldset className="pp-lesson-objectives">
                <legend>{messages.lessons.objectivesLabel}</legend>
                <Stack gap="xs">
                  {(topic?.objectives ?? []).map((objective) => (
                    <Checkbox
                      key={objective.id}
                      size="md"
                      label={objective.titlePl}
                      data-testid={`lesson-objective-${objective.id}`}
                      checked={values.objectiveIds.includes(objective.id)}
                      disabled={creating}
                      onChange={() => toggleObjective(objective.id)}
                    />
                  ))}
                </Stack>
              </fieldset>
            )}

            {source ? (
              <div data-testid="lesson-source" className="pp-lesson-source">
                <Group justify="space-between" align="center" gap="xs" wrap="wrap">
                  <Text fw={600} size="sm" id="lesson-source-title" className="pp-lesson-source-title">
                    {messages.sources.fromSource.replace("{title}", () => source.title)}
                  </Text>
                  <Anchor
                    href={changeSourceHref}
                    size="sm"
                    className="pp-lesson-source-change"
                    data-testid="lesson-source-change"
                    onClick={changeSource}
                  >
                    {messages.sources.changeSource}
                  </Anchor>
                </Group>
                {/* tekst źródła tylko do podglądu — serwer skopiuje go przy tworzeniu lekcji */}
                <Textarea
                  size="md"
                  readOnly
                  autosize
                  maxRows={12}
                  value={source.body}
                  className="pp-source-preview"
                  data-testid="lesson-source-preview"
                  aria-labelledby="lesson-source-title"
                />
              </div>
            ) : (
              <div>
                <Textarea
                  size="md"
                  label={fromMaterial ? messages.lessons.schoolMaterialLabel : messages.lessons.materialLabel}
                  data-testid="lesson-material"
                  autosize
                  minRows={6}
                  maxRows={16}
                  maxLength={materialMax}
                  placeholder={messages.lessons.materialPlaceholder}
                  disabled={creating}
                  aria-describedby="lesson-material-counter"
                  {...form.getInputProps("material")}
                />
                {path === "school" && <Text size="sm" mt={6} className="pp-editor-muted" data-testid="school-material-hint">{messages.lessons.schoolMaterialHint}</Text>}
                {path === "material" && <Text size="sm" mt={6} className="pp-editor-muted" data-testid="material-hint">{messages.lessons.chapterMaterialHint}</Text>}
                <Text size="sm" mt={6} ta="right" className="pp-editor-muted" id="lesson-material-counter" data-testid="lesson-material-counter">
                  {counterTemplate.replace("{n}", String(values.material.length))}
                </Text>
              </div>
            )}

            <TextInput size="md" label={messages.lessons.instructionLabel} data-testid="lesson-instruction" maxLength={500} disabled={creating}
              {...form.getInputProps("instruction")} />

            {showThemes && (
              <div data-testid="lesson-themes">
                <InterestsTagsInput
                  label={messages.lessons.themesTitle}
                  data-testid="lesson-themes-input"
                  disabled={themesLocked}
                  value={values.interests}
                  onChange={(next) => form.setFieldValue("interests", next)}
                  notice={interestNotice}
                  onNoticeChange={setInterestNotice}
                  description={<span data-testid="lesson-themes-note">{themesService}</span>}
                />
                {childrenWithInterests.length > 0 ? (
                  <Group gap="xs" mt="xs">
                    {childrenWithInterests.map((child) => (
                      <Button
                        key={child.id}
                        size="md"
                        variant="light"
                        data-testid={`lesson-themes-insert-${child.id}`}
                        disabled={themesLocked || themesFull || child.interests.every((entry) => themesPresent.has(normalizeChildInterest(entry).toLowerCase()))}
                        onClick={() => insertThemes(child.interests)}
                      >
                        {messages.lessons.themesInsert.replace("{name}", () => child.displayName)}
                      </Button>
                    ))}
                  </Group>
                ) : (
                  childrenQuery.isSuccess && <Text size="sm" mt={6} className="pp-editor-muted" data-testid="lesson-themes-empty">{messages.lessons.themesEmpty}</Text>
                )}
              </div>
            )}

            <NumberInput
              size="md"
              label={messages.lessons.poolSizeLabel}
              description={path === "material" ? messages.lessons.chapterPoolSizeHint : messages.lessons.poolSizeHint}
              data-testid="lesson-pool-size"
              className="pp-lesson-pool"
              min={POOL_MIN}
              max={fromMaterial ? MATERIAL_POOL_MAX : POOL_MAX}
              allowDecimal={false}
              allowNegative={false}
              clampBehavior="none"
              disabled={creating}
              value={values.poolSize}
              onChange={(value) => form.setValues({ poolSize: value, poolSizeTouched: true })}
            />
            {/* Katalog nie niesie typów ćwiczeń: wybór ze słuchu mają przedmioty z nagraniami zdań, czyli wszystkie poza szkolnym. */}
            {path !== "school" && (
              <Text size="sm" className="pp-editor-muted" data-testid="lesson-listen-choice-note">{messages.lessons.listenChoiceCreateNote}</Text>
            )}

            {submitError && (
              <Alert color="red" variant="light" role="alert" data-testid="api-error" icon={<ParentIcon name="alert-triangle" />}>
                <Stack gap={4} align="flex-start">
                  <span>{submitError}</span>
                  {sourceRefreshFailed && !sourceMissing && (
                    <Button size="md" variant="light" color="red" data-testid="lesson-source-refresh-retry" loading={refreshingSource}
                      onClick={() => void refreshSource(staleSourceRevision)}>
                      {messages.parentShell.retry}
                    </Button>
                  )}
                  {sourceMissing && (
                    <Anchor href={changeSourceHref} size="sm" className="pp-lesson-source-change" data-testid="lesson-source-missing-change" onClick={changeSource}>
                      {messages.sources.changeSource}
                    </Anchor>
                  )}
                </Stack>
              </Alert>
            )}
            <Group justify="flex-end">
              <Button
                size="md"
                className="pp-lesson-submit"
                data-testid="lesson-create-submit"
                leftSection={creating ? <Loader size={16} color="currentColor" /> : undefined}
                onClick={() => void submit()}
                disabled={creating || refreshingSource || sourceRefreshFailed || sourceOutdated || sourceMissing || (!hasPending && !canSubmitLesson(values, catalog, fromSource))}
              >
                {creating ? messages.lessons.creating : hasPending ? messages.lessons.retryCreate : messages.lessons.createLesson}
              </Button>
            </Group>
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
