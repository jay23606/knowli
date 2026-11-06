import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createLocalMediaStore } from "./local";

// Awaria w trakcie zapisu (pełny dysk, ubity proces): połowa bajtów trafia
// do pliku, potem błąd.
const failWrites = vi.hoisted(() => ({ next: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: (async (path, data, options) => {
      if (!failWrites.next) return actual.writeFile(path, data, options);
      failWrites.next = false;
      const bytes = data as Uint8Array;
      await actual.writeFile(path, bytes.subarray(0, bytes.byteLength >> 1), options);
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }) as typeof actual.writeFile,
  };
});

const root = await mkdtemp(join(tmpdir(), "knowli-store-"));
const store = createLocalMediaStore(root);

const bytesA = Uint8Array.from(Buffer.from("audio-bytes-a"));
const bytesB = Uint8Array.from(Buffer.from("audio-bytes-b"));

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalMediaStore", () => {
  it("putImmutable zapisuje raz i ponowne użycie tych samych bajtów zwraca ten sam klucz", async () => {
    const first = await store.putImmutable(bytesA, "audio/mpeg");
    const second = await store.putImmutable(bytesA, "audio/mpeg");
    expect(second.storageKey).toBe(first.storageKey);
    expect(first.contentSha256).toBe(sha(bytesA));
    expect(first.byteCount).toBe(bytesA.byteLength);
  });

  it("różne bajty dostają różne klucze", async () => {
    const a = await store.putImmutable(bytesA, "audio/mpeg");
    const b = await store.putImmutable(bytesB, "audio/mpeg");
    expect(b.storageKey).not.toBe(a.storageKey);
  });

  it("nie nadpisuje istniejącego pliku: sprzeczna zawartość pod tym samym hashem to błąd", async () => {
    const stored = await store.putImmutable(bytesA, "audio/mpeg");
    const target = join(root, stored.storageKey);
    await writeFile(target, Buffer.from("tampered"), { flag: "w" });
    await expect(store.putImmutable(bytesA, "audio/mpeg")).rejects.toThrow(/collision/i);
  });

  it("przerwany zapis nie zostawia częściowej treści pod nazwą docelową ani pliku tymczasowego", async () => {
    const bytes = Uint8Array.from(Buffer.from("audio-bytes-interrupted-write"));
    failWrites.next = true;
    await expect(store.putImmutable(bytes, "audio/mpeg")).rejects.toThrow(/no space/);
    const stored = await store.putImmutable(bytes, "audio/mpeg");
    const blob = await store.get(stored.storageKey);
    expect(Buffer.from(blob!.bytes).equals(Buffer.from(bytes))).toBe(true);
    const leftovers = await readdir(dirname(join(root, stored.storageKey)));
    expect(leftovers.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("sprząta porzucony plik tymczasowy blobu, a świeży (trwający zapis) zostawia", async () => {
    const bytes = Uint8Array.from(Buffer.from("audio-bytes-stale-temp"));
    const name = `${sha(bytes)}.mp3`;
    const dir = join(root, name.slice(0, 2));
    await mkdir(dir, { recursive: true });
    const stale = join(dir, `.${name}.stale.tmp`);
    const fresh = join(dir, `.${name}.fresh.tmp`);
    await writeFile(stale, "partial");
    await writeFile(fresh, "partial");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, twoHoursAgo, twoHoursAgo);
    await store.putImmutable(bytes, "audio/mpeg");
    expect((await readdir(dir)).filter((entry) => entry.startsWith(`.${name}.`))).toEqual([`.${name}.fresh.tmp`]);
  });

  it("get zwraca bajty i typ, a brakujący zasób null", async () => {
    const stored = await store.putImmutable(bytesB, "image/png");
    const blob = await store.get(stored.storageKey);
    expect(blob).not.toBeNull();
    expect(Buffer.from(blob!.bytes).equals(Buffer.from(bytesB))).toBe(true);
    expect(blob!.mimeType).toBe("image/png");
    expect(await store.get("aa/missing.png")).toBeNull();
    const wav = await store.putImmutable(bytesA, "audio/wav");
    expect(wav.storageKey).toMatch(/\.wav$/);
    expect((await store.get(wav.storageKey))?.mimeType).toBe("audio/wav");
  });

  it("getStream zwraca te same bajty w porcjach, z rozmiarem i typem", async () => {
    const stored = await store.putImmutable(bytesB, "image/webp");
    const streamed = await store.getStream!(stored.storageKey);
    expect(streamed).not.toBeNull();
    expect(streamed!.mimeType).toBe("image/webp");
    expect(streamed!.byteCount).toBe(bytesB.byteLength);
    const chunks: Uint8Array[] = [];
    for await (const chunk of streamed!.body) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(Buffer.from(bytesB))).toBe(true);
    expect(await store.getStream!("aa/missing.webp")).toBeNull();
    expect(await store.getStream!("../escape.webp")).toBeNull();
  });

  it("getStream porzucone przed pierwszą porcją kończy się bez błędu i bez danych", async () => {
    const stored = await store.putImmutable(Uint8Array.from(Buffer.from("audio-bytes-stream-cancel")), "audio/mpeg");
    const streamed = await store.getStream!(stored.storageKey);
    const iterator = streamed!.body[Symbol.asyncIterator]();
    await iterator.return?.();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("obsługuje webp — domyślny format ilustracji", async () => {
    const stored = await store.putImmutable(bytesA, "image/webp");
    expect(stored.storageKey).toMatch(/\.webp$/);
    const blob = await store.get(stored.storageKey);
    expect(blob!.mimeType).toBe("image/webp");
  });
});
