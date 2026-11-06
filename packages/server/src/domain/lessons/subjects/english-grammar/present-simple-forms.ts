import { normalizeTokens } from "../../normalize";

/**
 * Formy czasownika w Present Simple (3. osoba, wyjątki) wydzielone z walidatora
 * gramatyki, żeby korzystały z nich też inne walidatory bez cyklu importów.
 */

/** Deklaratywna tabela nieregularnych form 3. osoby / „be”. */
const IRREGULAR_THIRD_PERSON: Readonly<Record<string, readonly string[]>> = {
  have: ["has"],
  be: ["am", "is", "are"],
  do: ["does"],
  go: ["goes"],
};

/** Spółgłoski (do reguły y→ies: spółgłoska + y). */
const VOWELS = new Set(["a", "e", "i", "o", "u"]);

/**
 * Dopuszczalne formy czasownika w Present Simple dla danego bezokolicznika:
 * forma podstawowa, 3. osoba (+s / +es / y→ies) oraz wyjątki z tabeli.
 * Zwraca zbiór pojedynczych słów (bez operatora).
 */
export function presentSimpleForms(infinitive: string): Set<string> {
  const base = infinitive.toLowerCase();
  const forms = new Set<string>([base]);

  const irregular = IRREGULAR_THIRD_PERSON[base];
  if (irregular) {
    for (const form of irregular) {
      forms.add(form);
    }
    // „be” nie ma regularnej formy +s; „have”/„do”/„go” też używają wyjątku.
    return forms;
  }

  // Regularna 3. osoba.
  const last = base.at(-1) ?? "";
  const prev = base.at(-2) ?? "";
  if (/[sxo]$/.test(base) || base.endsWith("sh") || base.endsWith("ch")) {
    forms.add(`${base}es`); // -s/-sh/-ch/-x/-o → +es
  } else if (last === "y" && !VOWELS.has(prev)) {
    forms.add(`${base.slice(0, -1)}ies`); // spółgłoska + y → +ies
  } else {
    forms.add(`${base}s`);
  }
  return forms;
}

/**
 * Czy odpowiedź luki jest dopuszczalną formą Present Simple podanego czasownika.
 * Akceptuje też formy z operatorem: `does not play`, `doesn't play`, `do not go`.
 */
export function isAcceptablePresentSimpleAnswer(infinitive: string, answer: string): boolean {
  const tokens = normalizeTokens(answer);
  if (tokens.length === 0) {
    return false;
  }
  const base = infinitive.toLowerCase();
  const forms = presentSimpleForms(infinitive);

  // Forma prosta: jeden token będący dopuszczalną formą.
  if (tokens.length === 1) {
    return forms.has(tokens[0]!);
  }

  // Forma z operatorem: do/does [not] + forma podstawowa.
  // `doesn't` nie jest tu rozwinięty (normalizacja bazowa go nie rozwija),
  // więc akceptujemy warianty z apostrofem i rozdzielone.
  const operators = ["do", "does", "don't", "doesn't"];
  if (operators.includes(tokens[0]!)) {
    const rest = tokens.slice(1).filter((token) => token !== "not");
    return rest.length === 1 && rest[0] === base;
  }
  return false;
}
