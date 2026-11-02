/**
 * Zamknięta, deklaratywna tabela skrótów angielskich (design „Normalizacja”).
 * Dane należą do przedmiotów angielskich (`english_grammar`, `english_chapter`),
 * nie do silnika. Każdy skrót (klucz po normalizacji bazowej: lowercase,
 * apostrof zwykły) odwzorowuje się na listę równoważnych rozwinięć; skrót
 * wieloznaczny ma więcej niż jedno.
 *
 * Formy bez apostrofu są włączone WYŁĄCZNIE dla zamkniętej listy z briefu
 * (`doesnt`, `dont`, `isnt`, `arent`, `wasnt`, `werent`, `havent`, `hasnt`,
 * `wont`, `cant`, `didnt`) — formy przeczące, które dzieci często zapisują
 * bez apostrofu. Celowo NIE dodajemy bezapostrofowych wariantów form twierdzących
 * (`im`, `were`, `its`, `hes`…), bo kolidują ze zwykłymi słowami (`were` = past
 * „be”, `its` = zaimek dzierżawczy), a brief ich nie wymaga (YAGNI, bez
 * fałszywych równoważności).
 *
 * Jedyny dopuszczony dwuznaczny wyjątek: `wont` (bez apostrofu) rozwijamy do
 * `will not`, choć koliduje z rzeczownikiem „wont” (zwyczaj). W przedmiocie
 * gramatyki Present Simple dla ~8-latka rzeczownik „wont” nie wystąpi, więc
 * koszt jest zerowy, a korzyść (uczeń pisze „he wont play”) realna. Decyzja
 * należy do danych przedmiotu, nie silnika.
 *
 * Rozwinięcia podajemy jako gotowe sekwencje tokenów, by uniknąć ponownej
 * tokenizacji i zachować determinizm.
 */

/** Mapa: skrót → lista rozwinięć; każde rozwinięcie to sekwencja tokenów. */
export const CONTRACTIONS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  // --- Przeczenia operatorów (jednoznaczne), z formami bez apostrofu z briefu. ---
  "don't": [["do", "not"]],
  dont: [["do", "not"]],
  "doesn't": [["does", "not"]],
  doesnt: [["does", "not"]],
  "didn't": [["did", "not"]],
  didnt: [["did", "not"]],
  "isn't": [["is", "not"]],
  isnt: [["is", "not"]],
  "aren't": [["are", "not"]],
  arent: [["are", "not"]],
  "wasn't": [["was", "not"]],
  wasnt: [["was", "not"]],
  "weren't": [["were", "not"]],
  werent: [["were", "not"]],
  "haven't": [["have", "not"]],
  havent: [["have", "not"]],
  "hasn't": [["has", "not"]],
  hasnt: [["has", "not"]],
  "won't": [["will", "not"]],
  wont: [["will", "not"]], // dwuznaczne z rzeczownikiem „wont” — patrz nagłówek pliku
  // can't → dwa równoważne rozwinięcia (jedno słowo / dwa słowa).
  "can't": [["cannot"], ["can", "not"]],
  cant: [["cannot"], ["can", "not"]],

  // --- Formy twierdzące „be” / „have” / „will” (jednoznaczne, tylko z apostrofem). ---
  "i'm": [["i", "am"]],
  "you're": [["you", "are"]],
  "we're": [["we", "are"]],
  "they're": [["they", "are"]],
  "i've": [["i", "have"]],
  "you've": [["you", "have"]],
  "we've": [["we", "have"]],
  "they've": [["they", "have"]],
  "i'll": [["i", "will"]],
  "you'll": [["you", "will"]],
  "we'll": [["we", "will"]],
  "they'll": [["they", "will"]],
  "he'll": [["he", "will"]],
  "she'll": [["she", "will"]],
  "it'll": [["it", "will"]],

  // --- Wieloznaczne: 's → is | has. ---
  "he's": [
    ["he", "is"],
    ["he", "has"],
  ],
  "she's": [
    ["she", "is"],
    ["she", "has"],
  ],
  "it's": [
    ["it", "is"],
    ["it", "has"],
  ],
  "that's": [
    ["that", "is"],
    ["that", "has"],
  ],
  // Ramy pytań i „there is” z podręczników („Where's the…?”, „There's a…”, „What's…?”).
  "what's": [
    ["what", "is"],
    ["what", "has"],
  ],
  "where's": [
    ["where", "is"],
    ["where", "has"],
  ],
  "there's": [
    ["there", "is"],
    ["there", "has"],
  ],

  // --- Wieloznaczne: 'd → would | had. ---
  "i'd": [
    ["i", "would"],
    ["i", "had"],
  ],
  "you'd": [
    ["you", "would"],
    ["you", "had"],
  ],
  "we'd": [
    ["we", "would"],
    ["we", "had"],
  ],
  "they'd": [
    ["they", "would"],
    ["they", "had"],
  ],
  "he'd": [
    ["he", "would"],
    ["he", "had"],
  ],
  "she'd": [
    ["she", "would"],
    ["she", "had"],
  ],
  "it'd": [
    ["it", "would"],
    ["it", "had"],
  ],
};
