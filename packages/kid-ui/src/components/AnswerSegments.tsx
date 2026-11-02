import type { ReactElement } from "react";
import { m } from "motion/react";
import { messages, type SpellingDiffSegmentDto } from "@learning/contracts";
import { kidOutcomeIconAnimate, kidOutcomeIconInitial, kidOutcomeShake, kidOutcomeShakeTransition, kidSpringGentle, kidStaggerDelay } from "../motion/kid-motion";

/** Segmenty z zaznaczonymi pigułkami (reuse pisowni) — jedna etykietowana linia. */
type SpellingSegment = Pick<SpellingDiffSegmentDto, "state" | "text">;

/** One spelling-diff segment: differing letters pop in (expected/lesson)
 * or shake gently (the child's own), one after another. Plain segments
 * stay quiet. Only transform and opacity move. */
export function SpellingPill({ segment, index, variant, animation }: {
  segment: SpellingSegment;
  index: number;
  variant: "given" | "expected";
  animation: "pop" | "shake";
}): ReactElement {
  // „Nie na temat” (segmenty lekcji szkolnej, design §9.2): własny styl i etykieta.
  const offTopic = segment.state === "offtopic";
  const pill = segment.state === "pill" || offTopic;
  return (
    <m.span
      className={offTopic ? "kid-spelling-pill kid-spelling-pill--offtopic" : pill ? `kid-spelling-pill kid-spelling-pill--${variant}` : "kid-spelling-plain"}
      data-testid={offTopic ? "kid-spelling-offtopic" : pill ? "kid-spelling-pill" : undefined}
      initial={pill ? (animation === "pop" ? kidOutcomeIconInitial : { opacity: 1, x: 0 }) : false}
      animate={pill ? (animation === "pop" ? kidOutcomeIconAnimate : kidOutcomeShake) : undefined}
      transition={animation === "pop" ? { ...kidSpringGentle, delay: kidStaggerDelay(index) } : kidOutcomeShakeTransition}
      style={{ display: "inline-block" }}
    >
      {segment.text}
      {offTopic && <span className="kid-visually-hidden"> ({messages.kid.lessonSegmentOffTopic})</span>}
    </m.span>
  );
}

/** Zaznaczenie w akapicie: zbędne (pigułka) albo nie na temat; etykieta dla czytników ekranu. */
function TextSegment({ segment, labelled }: { segment: SpellingSegment; labelled: boolean }): ReactElement {
  if (segment.state === "plain") return <span className="kid-spelling-plain">{segment.text}</span>;
  const offTopic = segment.state === "offtopic";
  return (
    <span
      className={`kid-spelling-pill kid-spelling-pill--remove${offTopic ? " kid-spelling-pill--offtopic" : ""}`}
      data-testid={offTopic ? "kid-spelling-offtopic" : "kid-spelling-pill"}
    >
      {segment.text}
      {labelled && (
        <span className="kid-visually-hidden">
          {" "}({offTopic ? messages.kid.lessonSegmentOffTopic : messages.kid.lessonSegmentRedundant})
        </span>
      )}
    </span>
  );
}

/**
 * Legenda kategorii zaznaczeń — tylko te, które występują w tekście. Próbka
 * powtarza styl zaznaczenia (obwódka i dekoracja), więc kolor nie jest jedynym
 * nośnikiem; nieinteraktywna.
 */
function SegmentLegend({ segments }: { segments: readonly SpellingSegment[] }): ReactElement | null {
  const hasRedundant = segments.some((segment) => segment.state === "pill");
  const hasOffTopic = segments.some((segment) => segment.state === "offtopic");
  if (!hasOffTopic) return null;
  return (
    <ul className="kid-segment-legend" data-testid="kid-segment-legend">
      {hasRedundant && (
        <li className="kid-segment-legend__item">
          <span className="kid-spelling-pill kid-spelling-pill--remove kid-segment-legend__sample" aria-hidden="true">abc</span>
          {messages.kid.lessonSegmentRedundant}
        </li>
      )}
      <li className="kid-segment-legend__item">
        <span className="kid-spelling-pill kid-spelling-pill--remove kid-spelling-pill--offtopic kid-segment-legend__sample" aria-hidden="true">abc</span>
        {messages.kid.lessonSegmentOffTopic}
      </li>
    </ul>
  );
}

/** Słowo (części z zaznaczonymi literami), odstęp albo cały fragment „nie na temat”. */
type AnswerToken =
  | { kind: "word"; parts: SpellingSegment[] }
  | { kind: "space"; text: string }
  | { kind: "offtopic"; segment: SpellingSegment };

/**
 * Dzieli segmenty na słowa i odstępy, żeby słowo złożone z kilku segmentów
 * (zaznaczona litera w środku) łamało się tylko na odstępach. Fragment „nie
 * na temat” zostaje jednym zaznaczeniem z jedną etykietą dla czytnika.
 */
export function answerTokens(segments: readonly SpellingSegment[]): AnswerToken[] {
  const tokens: AnswerToken[] = [];
  let open: SpellingSegment[] | null = null;
  for (const segment of segments) {
    if (segment.state === "offtopic") {
      tokens.push({ kind: "offtopic", segment });
      open = null;
      continue;
    }
    for (const piece of segment.text.split(/(\s+)/u)) {
      if (piece === "") continue;
      if (/^\s/u.test(piece)) {
        tokens.push({ kind: "space", text: piece });
        open = null;
      } else if (open === null) {
        open = [{ text: piece, state: segment.state }];
        tokens.push({ kind: "word", parts: open });
      } else {
        open.push({ text: piece, state: segment.state });
      }
    }
  }
  return tokens;
}

function AnswerLine({ segments, variant }: { segments: readonly SpellingSegment[]; variant: "given" | "expected" }): ReactElement {
  let pill = 0;
  return (
    <>
      {answerTokens(segments).map((token, index) => {
        if (token.kind === "space") return <span key={index}>{token.text}</span>;
        if (token.kind === "offtopic") {
          return <SpellingPill key={index} segment={token.segment} index={pill++} variant={variant} animation="pop" />;
        }
        return (
          <span key={index} className="kid-lesson-word">
            {token.parts.map((part, partIndex) => part.state === "plain"
              ? <span key={partIndex}>{part.text}</span>
              : <SpellingPill key={partIndex} segment={part} index={pill++} variant={variant} animation="pop" />)}
          </span>
        );
      })}
    </>
  );
}

/**
 * Feedback lekcji: odpowiedź dziecka i poprawna odpowiedź z zaznaczonymi
 * literami (makieta 2026-11-02). Krótkie odpowiedzi (po jednym słowie) stoją
 * w dwóch wierszach z etykietami z boku, dłuższe — pod etykietami na całą
 * szerokość. Tekst łamie się tylko między słowami. Kolor nie jest jedynym
 * nośnikiem: zaznaczenie ma obwódkę i podkreślenie, a wiersz etykietę.
 */
export function LessonAnswerComparison({ answerSegments, correctText, correctSegments }: {
  answerSegments: readonly SpellingSegment[] | null;
  correctText: string | null;
  correctSegments: readonly SpellingSegment[] | null;
}): ReactElement | null {
  const given = answerSegments !== null && answerSegments.length > 0 ? answerSegments : null;
  if (given === null && correctText === null) return null;
  const singleWord = (text: string) => !/\s/u.test(text.trim());
  const inline = (given === null || singleWord(given.map((segment) => segment.text).join(""))) &&
    (correctText === null || singleWord(correctText));
  return (
    <div className="kid-lesson-compare" data-layout={inline ? "inline" : "stacked"} data-testid="kid-lesson-compare">
      {given !== null && (
        <>
          <span className="kid-spelling-row-label kid-lesson-compare__label">{messages.kid.lessonYourAnswer}</span>
          <span className="kid-lesson-compare__answer" data-testid="kid-lesson-answer-segments">
            <AnswerLine segments={given} variant="given" />
          </span>
        </>
      )}
      {correctText !== null && (
        <>
          <span className="kid-spelling-row-label kid-lesson-compare__label">{messages.kid.lessonCorrectAnswer}</span>
          <span className="kid-lesson-compare__answer kid-lesson-compare__answer--expected" data-testid="kid-lesson-correct" lang="en-GB">
            <AnswerLine segments={correctSegments ?? [{ text: correctText, state: "plain" }]} variant="expected" />
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Odpowiedź dziecka z zaznaczonymi segmentami pod etykietą tekstową (kolor
 * nie jest jedynym nośnikiem — pigułka ma obwódkę). Układ `word` to
 * dotychczasowy wiersz feedbacku (krótkie odpowiedzi, duża czcionka, pigułki
 * wskakują po kolei). Układ `text` służy do dłuższego tekstu ciągłego (np.
 * „Skróć odpowiedź”): akapit w czytelnej wielkości, który zawija się jak
 * zwykły tekst; pigułki pokazują fragmenty do usunięcia (przekreślenie jako
 * drugi kanał) i są statyczne — transform nie działa na elementach inline.
 */
export function AnswerSegments({ segments, label, testid, layout = "word", pillDescription }: {
  segments: readonly SpellingSegment[] | undefined;
  label: string;
  testid: string;
  layout?: "word" | "text";
  /** Opis zaznaczonych fragmentów dla czytników ekranu (układ `text`). */
  pillDescription?: string;
}): ReactElement | null {
  if (segments === undefined || segments.length === 0) return null;
  if (layout === "text") {
    // Dwie kategorie (zbędne / nie na temat) dostają etykietę przy każdym fragmencie i legendę.
    const categorized = segments.some((segment) => segment.state === "offtopic");
    return (
      <div className="kid-answer-segments-text" data-testid={testid}>
        <span className="kid-spelling-row-label">{label}</span>
        <p className="kid-answer-segments-text__body">
          {segments.map((segment, index) => <TextSegment key={index} segment={segment} labelled={categorized} />)}
        </p>
        <SegmentLegend segments={segments} />
        {pillDescription !== undefined && <p className="kid-visually-hidden">{pillDescription}</p>}
      </div>
    );
  }
  return (
    <div className="kid-spelling-row" data-testid={testid}>
      <span className="kid-spelling-row-label">{label}</span>
      {segments.map((segment, index) => (
        <SpellingPill key={index} segment={segment} index={index} variant="given" animation="pop" />
      ))}
    </div>
  );
}
