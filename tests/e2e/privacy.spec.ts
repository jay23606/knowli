import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { E2E_SETUP_TOKEN } from "./helpers/parent-session";
import {
  ApiErrorSchema,
  AttemptDtoSchema,
  DisclosureDtoSchema,
  SessionDtoSchema,
  TaskDtoSchema,
} from "@learning/contracts";

/**
 * Prywatność Kid API (zadanie 7): odpowiedzi dziecka przechodzą przez HTTP,
 * a w żadnej odpowiedzi nie ma klucza odpowiedzi, kryteriów oceny ani
 * technicznych score'ów. Świat (baza, web, worker z fake providerami)
 * stawia global-setup; setup materiału prowadzimy przez API rodzica.
 */

const FORBIDDEN_KEYS = [
  "answerKey",
  "answer_key",
  "acceptedAnswers",
  "correctOptionId",
  "correctOption",
  "skillVersion",
  "criteria",
  "score",
  "provider",
  "streak",
  "nextReviewAt",
  "independent",
] as const;

function expectNoSecrets(body: unknown): void {
  const serialized = JSON.stringify(body);
  for (const key of FORBIDDEN_KEYS) {
    expect(serialized, `odpowiedź nie może zawierać ${key}`).not.toContain(`"${key}"`);
  }
  expect(serialized).not.toContain("postgres://");
  expect(serialized).not.toContain("sk-");
}

test("kid API prowadzi sesję bez ujawniania kluczy odpowiedzi", async ({ page }) => {
  test.slow();

  // Setup rodzica przez HTTP (cookie sesji dzieli kontekst strony)
  const parent = page.request;
  const setup = await parent.post("/api/v1/parent/setup", { data: { secret: "1234", setupToken: E2E_SETUP_TOKEN } });
  expect([201, 409]).toContain(setup.status());
  const login = await parent.post("/api/v1/parent/login", { data: { secret: "1234" } });
  expect(login.status()).toBe(200);

  const child = await (
    await parent.post("/api/v1/parent/children", {
      data: { displayName: "Ola", avatarKey: "fox", birthYear: 2018 },
    })
  ).json();
  expect(child.id).toBeDefined();

  const generate = await parent.post("/api/v1/parent/decks/generate", {
    data: {
      prompt: "angielskie dni tygodnia dla początkującego dziecka",
      idempotencyKey: "privacy-spec-deck-1",
      title: "Dni tygodnia",
    },
  });
  expect(generate.status()).toBe(202);
  const { deckId } = await generate.json();

  // worker z fake providerami kończy generację; polling do sukcesu
  let draftId: string | null = null;
  for (let attempt = 0; attempt < 960 && draftId === null; attempt++) {
    const deck = await (await parent.get(`/api/v1/parent/decks/${deckId}`)).json();
    if (deck.generation?.state === "succeeded" && deck.draft) {
      draftId = deck.draft.id;
    } else {
      await page.waitForTimeout(250);
    }
  }
  expect(draftId).not.toBeNull();

  // publikacja po zakończeniu audio (fake TTS jest szybkie po generacji)
  let published = false;
  let editNumber = 0;
  for (let attempt = 0; attempt < 720 && !published; attempt++) {
    const draft = await (await parent.get(`/api/v1/parent/drafts/${draftId}`)).json();
    editNumber = draft.editNumber;
    const audioPending = draft.assets.some(
      (asset: { role: string; state: string }) => asset.role === "target_audio" && asset.state !== "approved",
    );
    if (!audioPending) {
      const result = await parent.post(`/api/v1/parent/drafts/${draftId}/publish`, {
        data: { expectedEditNumber: editNumber },
      });
      published = result.status() === 200;
    } else {
      await page.waitForTimeout(250);
    }
  }
  expect(published).toBe(true);

  const assign = await parent.put(`/api/v1/parent/assignments/${child.id}/${deckId}`, { data: { testDate: null } });
  expect(assign.status()).toBe(204);

  // Kid API: profile i zestawy bez danych technicznych
  const profiles = await (await parent.get("/api/v1/kid/profiles")).json();
  expect(profiles.some((p: { childId: string }) => p.childId === child.id)).toBe(true);
  expectNoSecrets(profiles);

  const decks = await (await parent.get(`/api/v1/kid/decks?childId=${child.id}`)).json();
  expect(decks.some((d: { deckId: string }) => d.deckId === deckId)).toBe(true);
  expectNoSecrets(decks);

  // sesja bez mikrofonu
  const sessionResponse = await parent.post("/api/v1/kid/sessions", {
    data: { childId: child.id, deckId, microphoneEnabled: false },
  });
  expect(sessionResponse.status()).toBe(200);
  const session = await sessionResponse.json();
  expect(SessionDtoSchema.safeParse(session).success).toBe(true);
  expectNoSecrets(session);

  // ścieżka mowy (zadanie 8): multipart z realnym kontenerem przechodzi przez
  // router, ale odpowiedź ustna należy tylko do zadań recall/speech — zadanie
  // rozpoznawania odrzuca ją walidacją, a limit strumienia ucina nadmiar
  let speechTask: { taskId: string; exerciseType: string } | null = null;
  for (let step = 0; step < 10 && speechTask === null; step++) {
    const response = await parent.post(`/api/v1/kid/sessions/${session.sessionId}/next`);
    expect(response.status()).toBe(200);
    const task = await response.json();
    if (task === null) break;
    if (task.exerciseType !== "exposure") {
      speechTask = task;
      break;
    }
    await parent.post(`/api/v1/kid/tasks/${task.taskId}/complete-presentation`, {
      data: { clientCommandId: randomUUID() },
    });
  }
  expect(speechTask).not.toBeNull();

  // krótkie WAV 8 kHz mono 16-bit — rzeczywisty kontener z wyliczalnym czasem
  const dataBytes = 8000;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);

  const speech = await parent.post(`/api/v1/kid/tasks/${speechTask!.taskId}/attempts`, {
    multipart: {
      clientAttemptId: randomUUID(),
      audio: { name: "recording.wav", mimeType: "audio/wav", buffer: wav },
    },
  });
  expect(speech.status()).toBe(400);
  const speechError = await speech.json();
  expect(ApiErrorSchema.safeParse(speechError).success).toBe(true);
  expectNoSecrets(speechError);

  // nadmiarowy multipart odrzuca limit strumienia przed pełnym buforowaniem
  const oversized = await parent.post(`/api/v1/kid/tasks/${speechTask!.taskId}/attempts`, {
    multipart: {
      clientAttemptId: randomUUID(),
      audio: { name: "big.wav", mimeType: "audio/wav", buffer: Buffer.alloc(3 * 1024 * 1024, 1) },
    },
  });
  expect(oversized.status()).toBe(400);
  expect(ApiErrorSchema.safeParse(await oversized.json()).success).toBe(true);

  // kilkanaście kroków nauki: prezentacje kończymy, oceniane zadania obsługujemy
  const seenBodies: unknown[] = [session];
  for (let step = 0; step < 14; step++) {
    const nextResponse = await parent.post(`/api/v1/kid/sessions/${session.sessionId}/next`);
    expect(nextResponse.status()).toBe(200);
    const task = await nextResponse.json();
    if (task === null) break;
    expect(TaskDtoSchema.safeParse(task).success).toBe(true);
    expectNoSecrets(task);
    seenBodies.push(task);

    if (task.exerciseType === "exposure") {
      const done = await parent.post(`/api/v1/kid/tasks/${task.taskId}/complete-presentation`, {
        data: { clientCommandId: crypto.randomUUID() },
      });
      expect(done.status()).toBe(200);
      expectNoSecrets(await done.json());
      continue;
    }

    // odpowiedź: wybór albo tekst; treść nie musi być poprawna — prywatność
    // odpowiedzi nie zależy od wyniku, ale chcemy zobaczyć też feedback
    if (task.prompt.kind === "listening" || task.prompt.kind === "reading" || task.prompt.kind === "reverse_recognition") {
      const option = task.prompt.options[0];
      const attemptResponse = await parent.post(`/api/v1/kid/tasks/${task.taskId}/attempts`, {
        data: { taskId: task.taskId, clientAttemptId: crypto.randomUUID(), modality: "choice", optionId: option.id },
      });
      expect(attemptResponse.status()).toBe(200);
      const attempt = await attemptResponse.json();
      expect(AttemptDtoSchema.safeParse(attempt).success).toBe(true);
      expectNoSecrets(attempt);
      seenBodies.push(attempt);
    } else {
      const clientAttemptId = crypto.randomUUID();
      const attemptResponse = await parent.post(`/api/v1/kid/tasks/${task.taskId}/attempts`, {
        data: {
          taskId: task.taskId,
          clientAttemptId,
          modality: "text",
          text: "monday",
        },
      });
      expect(attemptResponse.status()).toBe(200);
      const attempt = await attemptResponse.json();
      expect(AttemptDtoSchema.safeParse(attempt).success).toBe(true);
      expectNoSecrets(attempt);
      seenBodies.push(attempt);

      // retry transportowy z tym samym clientAttemptId zwraca ten sam wynik
      const retry = await parent.post(`/api/v1/kid/tasks/${task.taskId}/attempts`, {
        data: {
          taskId: task.taskId,
          clientAttemptId,
          modality: "text",
          text: "monday",
        },
      });
      expect(retry.status()).toBe(200);
      const retryBody = await retry.json();
      expect(retryBody.attemptId).toBe(attempt.attemptId);
      expectNoSecrets(retryBody);
    }
  }

  // ujawnienia: podpowiedź ma serwerowy stepId i zapis ekspozycji przed odpowiedzią
  const disclosure = await parent.post(`/api/v1/kid/sessions/${session.sessionId}/next`);
  const nextTask = await disclosure.json();
  if (nextTask !== null && nextTask.exerciseType !== "exposure") {
    const hint = await parent.post(`/api/v1/kid/tasks/${nextTask.taskId}/disclosures`, { data: { kind: "hint" } });
    if (hint.status() === 200) {
      const hintBody = await hint.json();
      expect(DisclosureDtoSchema.safeParse(hintBody).success).toBe(true);
      expect(hintBody.reveal).toHaveProperty("target");
      expectNoSecrets(hintBody);
    }
  }

  // odczyt nieistniejącej próby: jednolity błąd bez wycieku szczegółów
  const missing = await parent.get("/api/v1/kid/attempts/00000000-0000-0000-0000-000000000000");
  expect(missing.status()).toBe(404);
  const errorBody = await missing.json();
  expect(ApiErrorSchema.safeParse(errorBody).success).toBe(true);
  expectNoSecrets(errorBody);

  // koniec sesji z podsumowaniem
  const end = await parent.post(`/api/v1/kid/sessions/${session.sessionId}/end`);
  expect(end.status()).toBe(200);
  expectNoSecrets(await end.json());

  void seenBodies;
});
