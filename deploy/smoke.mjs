// Test dymny stacka Knowli/Umiem! (zadanie 11) — prowadzi pełny obieg przez
// publiczne API, bez przeglądarki:
//   run    <baseUrl> <stateFile>  — setup → profil → fake generacja → publikacja
//                                   → przypisanie → sesja dziecka → zapis stanu
//   verify <baseUrl> <stateFile>  — po restarcie procesów: te same profile,
//                                   zestawy, postęp i bajty mediów
//   inspect <baseUrl> <pin>       — zrzut stanu (profile/zestawy/postęp/media)
//                                   jako JSON; używany przy weryfikacji restore
import { createHash, randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";

const MODE = process.argv[2];
const BASE = process.argv[3]?.replace(/\/$/, "");
if (!MODE || !BASE) {
  fail(`użycie: smoke.mjs <run|verify|inspect> <baseUrl> [stateFile|pin]`);
}

const SMOKE_PIN = "2468-smoke";
// = UMIEM_SETUP_TOKEN web w deploy/compose.smoke.yaml (#307)
const SMOKE_SETUP_TOKEN = "smoke-setup-token";
const DECK_TITLE = "Smoke — dni tygodnia";

/** Odpowiedzi z momentami (…At) są nietrwałe między odczytami — porównujemy bez nich. */
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.endsWith("At"))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
}

function fail(message) {
  console.error(`[smoke] FAIL: ${message}`);
  process.exit(1);
}

async function api(method, path, { cookie, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      // kontrola Origin/CSRF wymaga zgodnego origin przy mutacjach
      origin: BASE,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response;
}

async function call(method, path, { cookie, body } = {}) {
  const response = await api(method, path, { cookie, body });
  if (!response.ok) {
    const text = await response.text();
    fail(`${method} ${path} → ${response.status}: ${text.slice(0, 400)}`);
  }
  return response;
}

function cookieOf(response) {
  const cookies = response.headers.getSetCookie?.() ?? [];
  const session = cookies.find((entry) => entry.startsWith("parent_session="));
  if (!session) fail("logowanie nie ustawiło cookie parent_session");
  return session.split(";")[0];
}

async function login(pin) {
  const status = await (await call("GET", "/api/v1/parent/login")).json();
  if (status.setupRequired) {
    await call("POST", "/api/v1/parent/setup", { body: { secret: pin, setupToken: SMOKE_SETUP_TOKEN } });
  }
  return cookieOf(await call("POST", "/api/v1/parent/login", { body: { secret: pin } }));
}

async function hashMedia(assetId) {
  const response = await call("GET", `/api/v1/media/${assetId}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    assetId,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteCount: bytes.byteLength,
    contentType: response.headers.get("content-type"),
  };
}

async function checkStaticAssets() {
  const home = await call("GET", "/");
  const html = await home.text();
  const asset = html.match(/"(\/_next\/static\/[^"]+)"/)?.[1];
  if (!asset) fail("strona główna nie odwołuje się do zasobów /_next/static");
  await call("GET", asset);
  await call("GET", "/manifest.webmanifest");
}

async function waitFor(label, deadlineMs, check) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) fail(`przekroczono czas na: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Sesja dziecka do końca: exposure kończymy, wybory/teksty odpowiadamy, powtórzone zadanie pomijamy. */
async function runSession(cookie, childId, deckId) {
  const session = await (
    await call("POST", "/api/v1/kid/sessions", {
      cookie,
      body: { childId, deckId, microphoneEnabled: false },
    })
  ).json();
  const attemptsByTask = new Map();
  const feedbackKinds = {};
  let summary = null;

  for (let issued = 0; issued < 200; issued++) {
    const next = await api("POST", `/api/v1/kid/sessions/${session.sessionId}/next`, { cookie });
    if (next.status === 204) break;
    if (!next.ok) fail(`next → ${next.status}: ${await next.text()}`);
    const task = await next.json();

    if (task.prompt.kind === "exposure") {
      await call("POST", `/api/v1/kid/tasks/${task.taskId}/complete-presentation`, { cookie, body: {} });
      continue;
    }

    const seen = attemptsByTask.get(task.taskId) ?? 0;
    attemptsByTask.set(task.taskId, seen + 1);
    const modality = seen > 0 ? "skip" : answerOf(task.prompt);
    const attempt = await (
      await call("POST", `/api/v1/kid/tasks/${task.taskId}/attempts`, {
        cookie,
        body: {
          clientAttemptId: randomUUID(),
          modality,
          ...(modality === "choice" ? { optionId: task.prompt.options[0].id } : {}),
          ...(modality === "text" ? { text: "monday" } : {}),
        },
      })
    ).json();
    feedbackKinds[attempt.feedback?.kind ?? "processing"] =
      (feedbackKinds[attempt.feedback?.kind ?? "processing"] ?? 0) + 1;
  }

  summary = await (
    await call("POST", `/api/v1/kid/sessions/${session.sessionId}/end`, { cookie })
  ).json();
  return { session, summary, feedbackKinds };
}

function answerOf(prompt) {
  if (prompt.options) return "choice";
  if (prompt.kind === "recall" || prompt.kind === "spelling" || prompt.kind === "letter_completion") {
    return "text";
  }
  if (prompt.kind === "speech") return "skip";
  fail(`nieznany typ zadania w teście dymnym: ${prompt.kind}`);
}

// ── run ──────────────────────────────────────────────────────────────────────
async function runMode(stateFile) {
  await waitFor("health web", 120_000, async () => {
    const response = await fetch(`${BASE}/api/v1/health`).catch(() => null);
    return response?.ok ?? false;
  });

  const cookie = await login(SMOKE_PIN);
  await checkStaticAssets();

  const child = await (
    await call("POST", "/api/v1/parent/children", {
      cookie,
      body: { displayName: "Ola", avatarKey: "fox", birthYear: 2018 },
    })
  ).json();

  const generation = await (
    await call("POST", "/api/v1/parent/decks/generate", {
      cookie,
      body: {
        prompt: "angielskie dni tygodnia dla początkującego dziecka",
        idempotencyKey: `smoke-${randomUUID()}`,
        title: DECK_TITLE,
        maxItems: 7,
        locales: { source: "pl-PL", target: "en-GB" },
      },
    })
  ).json();

  const run = await waitFor("generacja", 180_000, async () => {
    const dto = await (await call("GET", `/api/v1/parent/generation/${generation.generationRunId}`, { cookie })).json();
    if (dto.state === "failed") fail(`generacja nieudana: ${dto.errorCode}`);
    return dto.state === "succeeded" ? dto : null;
  });

  // publikacja wymaga obowiązkowego TTS (i obrazów lub ich jawnego pominięcia)
  const deckId = run.deckId;
  const deck = await waitFor("media zasobów", 180_000, async () => {
    const dto = await (await call("GET", `/api/v1/parent/decks/${deckId}`, { cookie })).json();
    const draft = dto.draft;
    if (!draft) return null;
    const itemsById = new Map(draft.items.map((item) => [item.revisionId, item]));
    const audioOk = draft.items.every((item) =>
      draft.assets.some((asset) => asset.itemRevisionId === item.revisionId && asset.role === "target_audio" && asset.state === "approved"),
    );
    const imageOk = draft.items.every((item) =>
      itemsById.get(item.revisionId).visualType !== "image" ||
      draft.assets.some((asset) => asset.itemRevisionId === item.revisionId && asset.role === "illustration" && (asset.state === "approved" || asset.state === "omitted")),
    );
    return audioOk && imageOk ? dto : null;
  });
  const draft = deck.draft;

  const published = await call("POST", `/api/v1/parent/drafts/${draft.id}/publish`, {
    cookie,
    body: { expectedEditNumber: draft.editNumber },
  });
  const { deckVersionId } = await published.json();

  const testDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  await call("PUT", `/api/v1/parent/assignments/${child.id}/${deckId}`, { cookie, body: { testDate } });

  const kidDecks = await (
    await call("GET", `/api/v1/kid/decks?childId=${child.id}`, { cookie })
  ).json();
  if (!kidDecks.some((kidDeck) => kidDeck.deckId === deckId && kidDeck.testDate === testDate)) {
    fail("zestaw nie jest widoczny dla dziecka po przypisaniu");
  }

  const { session, summary, feedbackKinds } = await runSession(cookie, child.id, deckId);

  const progress = await (
    await call("GET", `/api/v1/parent/progress?childId=${child.id}&deckId=${deckId}`, { cookie })
  ).json();

  const publishedDeck = await (await call("GET", `/api/v1/parent/decks/${deckId}`, { cookie })).json();
  const audioAsset = publishedDeck.published.assets.find(
    (asset) => asset.role === "target_audio" && asset.assetId,
  );
  if (!audioAsset) fail("opublikowana wersja nie ma gotowego audio");

  const state = {
    pin: SMOKE_PIN,
    childId: child.id,
    deckId,
    deckVersionId,
    sessionId: session.sessionId,
    testDate,
    summary: normalize(summary),
    feedbackKinds,
    progress: normalize(progress),
    media: await hashMedia(audioAsset.assetId),
  };
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  console.log(
    `[smoke] run: sesja ${session.sessionId} (${summary.tasksIssued} zadań, stan ${summary.state}), postęp zapisany w ${stateFile}`,
  );
}

// ── verify ───────────────────────────────────────────────────────────────────
async function verifyMode(stateFile) {
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const cookie = await login(state.pin);
  await checkStaticAssets();

  const children = await (await call("GET", "/api/v1/parent/children", { cookie })).json();
  if (!children.some((candidate) => candidate.id === state.childId)) {
    fail(`profil dziecka ${state.childId} nie przetrwał restartu`);
  }

  const kidDecks = await (
    await call("GET", `/api/v1/kid/decks?childId=${state.childId}`, { cookie })
  ).json();
  const kidDeck = kidDecks.find((candidate) => candidate.deckId === state.deckId);
  if (!kidDeck) fail("zestaw nie jest dostępny dla dziecka po restarcie");
  if (kidDeck.testDate !== state.testDate) {
    fail(`termin sprawdzianu się zmienił: ${kidDeck.testDate} ≠ ${state.testDate}`);
  }

  const progress = await (
    await call("GET", `/api/v1/parent/progress?childId=${state.childId}&deckId=${state.deckId}`, { cookie })
  ).json();
  if (JSON.stringify(normalize(progress)) !== JSON.stringify(state.progress)) {
    fail(`postęp po restarcie różni się:\nprzed: ${JSON.stringify(state.progress)}\npo:    ${JSON.stringify(normalize(progress))}`);
  }

  const media = await hashMedia(state.media.assetId);
  for (const key of ["sha256", "byteCount", "contentType"]) {
    if (media[key] !== state.media[key]) fail(`media ${key} różni się po restarcie: ${media[key]} ≠ ${state.media[key]}`);
  }

  console.log(
    `[smoke] verify: PASS — profil, zestaw (${state.deckVersionId}), postęp i ${media.byteCount} B audio są identyczne po restarcie`,
  );
}

// ── inspect ──────────────────────────────────────────────────────────────────
async function inspectMode(pin) {
  const cookie = await login(pin);
  const children = await (await call("GET", "/api/v1/parent/children", { cookie })).json();
  const result = { children: [], decks: [] };
  for (const child of children) {
    const kidDecks = await (
      await call("GET", `/api/v1/kid/decks?childId=${child.id}`, { cookie })
    ).json();
    result.children.push({ id: child.id, displayName: child.displayName, decks: kidDecks.map((d) => d.title) });
  }
  const decks = await (await call("GET", "/api/v1/parent/decks", { cookie })).json();
  for (const summary of decks) {
    if (!summary.publishedVersionId) continue;
    const deck = await (await call("GET", `/api/v1/parent/decks/${summary.deckId}`, { cookie })).json();
    const media = [];
    for (const asset of deck.published.assets.filter((a) => a.role === "target_audio" && a.assetId).slice(0, 3)) {
      media.push(await hashMedia(asset.assetId));
    }
    // kolejność zapytania SQL nie jest umową — sortujemy dla powtarzalnych diffów
    media.sort((a, b) => a.assetId.localeCompare(b.assetId));
    result.decks.push({
      deckId: summary.deckId,
      title: summary.title,
      publishedVersionId: summary.publishedVersionId,
      items: deck.published.items.length,
      media,
    });
  }
  for (const child of children) {
    for (const deck of decks) {
      if (!deck.publishedVersionId) continue;
      const progress = await (
        await call("GET", `/api/v1/parent/progress?childId=${child.id}&deckId=${deck.deckId}`, { cookie })
      ).json();
      result.decks.find((d) => d.deckId === deck.deckId).progress ??= {};
      result.decks.find((d) => d.deckId === deck.deckId).progress[child.displayName] = normalize(progress);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

if (MODE === "run") await runMode(process.argv[4]);
else if (MODE === "verify") await verifyMode(process.argv[4]);
else if (MODE === "inspect") await inspectMode(process.argv[4]);
else fail(`nieznany tryb: ${MODE}`);
