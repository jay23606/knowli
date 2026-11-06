import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { MediaStore, StoredBlob } from "../../ports/media";

const EXT_BY_MIME: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

// storageKey ma zawsze postać "xx/hash.ext" — odrzucamy wszystko inne.
const KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{64}\.(mp3|wav|png|jpg|webp)$/;

// Plik tymczasowy starszy niż to został po awarii procesu (żywy zapis trwa sekundy).
const STALE_TMP_MS = 60 * 60 * 1000;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Usuwa porzucone pliki tymczasowe tego blobu; best effort, błędy pomija. */
async function removeStaleTemps(dir: string, blobName: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(`.${blobName}.`) || !name.endsWith(".tmp")) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info && now - info.mtimeMs > STALE_TMP_MS) await unlink(path).catch(() => undefined);
  }
}

/** Utrwala wpis katalogu (nowy link). Windows nie pozwala otworzyć katalogu do fsync. */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Prywatny wolumen: klucz adresowany treścią. Bajty trafiają najpierw do
 * pliku tymczasowego w tym samym katalogu (z fsync), a nazwa docelowa
 * powstaje atomowo przez `link`, który nie nadpisuje — pod kluczem nigdy nie
 * ma częściowej treści. Istniejący blob o tym samym hashu jest weryfikowany i
 * użyty ponownie; sprzeczna zawartość to błąd, nigdy cicha podmiana.
 */
export function createLocalMediaStore(rootDir: string): MediaStore {
  const pathOf = (storageKey: string) => join(rootDir, storageKey);

  return {
    async putImmutable(bytes: Uint8Array, mimeType: string): Promise<StoredBlob> {
      const ext = EXT_BY_MIME[mimeType];
      if (!ext) {
        throw new Error(`unsupported media type: ${mimeType}`);
      }
      const contentSha256 = sha256(bytes);
      const storageKey = `${contentSha256.slice(0, 2)}/${contentSha256}.${ext}`;
      const target = pathOf(storageKey);
      const dir = dirname(target);
      await mkdir(dir, { recursive: true });
      await removeStaleTemps(dir, basename(target));
      const temp = join(dir, `.${basename(target)}.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, bytes, { flag: "wx", flush: true });
        await link(temp, target);
        await syncDir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        const existing = await readFile(target);
        if (sha256(Uint8Array.from(existing)) !== contentSha256) {
          throw new Error(`blob collision at ${storageKey}: content mismatch`);
        }
      } finally {
        await unlink(temp).catch(() => undefined);
      }
      return { storageKey, contentSha256, byteCount: bytes.byteLength };
    },

    async getStream(storageKey: string) {
      if (!KEY_PATTERN.test(storageKey)) {
        return null;
      }
      const target = pathOf(storageKey);
      let size: number;
      try {
        size = (await stat(target)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
      const ext = storageKey.split(".")[1]!;
      return {
        mimeType: MIME_BY_EXT[ext],
        byteCount: size,
        body: (async function* () {
          // Strumień powstaje dopiero przy pierwszej porcji i jest niszczony
          // także przy anulowaniu przed/po starcie — inaczej porzucone body
          // zostawiałoby otwarty deskryptor pliku.
          const stream = createReadStream(target);
          try {
            for await (const chunk of stream) {
              yield Uint8Array.from(chunk as Buffer);
            }
          } finally {
            stream.destroy();
          }
        })(),
      };
    },

    async get(storageKey: string) {
      if (!KEY_PATTERN.test(storageKey)) {
        return null;
      }
      try {
        const bytes = await readFile(pathOf(storageKey));
        const ext = storageKey.split(".")[1]!;
        return { bytes: Uint8Array.from(bytes), mimeType: MIME_BY_EXT[ext] };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
  };
}
