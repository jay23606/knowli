"use client";

import { useRef, useState, type ReactNode } from "react";
import { TagsInput } from "@mantine/core";
import { MAX_CHILD_INTERESTS, messages, normalizeChildInterest } from "@learning/contracts";
import { interestsError, parseInterestsInput } from "./children-forms";

/** Krótki komunikat po próbie dodania powtórzenia lub szóstego tematu (znika przy dalszym pisaniu). */
export type InterestNotice = "duplicate" | "limit";

export function useInterestNotice() {
  return useState<InterestNotice | null>(null);
}

/** Tekst komunikatu dla pola: błąd wpisu ma pierwszeństwo przed powtórzeniem i limitem. */
export function interestFieldMessage(value: readonly string[], notice: InterestNotice | null): string | null {
  return interestsError(value)
    ?? (notice === "duplicate" ? messages.children.interestsDuplicate : null)
    ?? (notice === "limit" ? messages.children.interestsLimit.replace("{max}", String(MAX_CHILD_INTERESTS)) : null);
}

const SPLIT_CHARS = [","];

/** Lista, którą dałoby rozbicie tekstu po przecinkach (wklejenie albo przecinek) bez limitu. */
export function splitInterestCandidates(current: readonly string[], text: string): string[] {
  return [...current, ...text.split(new RegExp(`[${SPLIT_CHARS.join("")}]`))];
}

/**
 * Komunikat po rozbiciu tekstu na tematy. Mantine ucina wtedy listę do `maxTags` bez
 * `onMaxTags` i usuwa tylko dokładne powtórzenia, więc porównujemy znormalizowanych
 * kandydatów z tym, co zostało w polu: brakujący temat to limit, a zwinięty wpis — powtórzenie.
 */
export function splitInterestNotice(candidates: readonly string[], kept: readonly string[]): InterestNotice | null {
  const wanted = parseInterestsInput(candidates);
  const keptKeys = new Set(parseInterestsInput(kept).map((entry) => entry.toLowerCase()));
  if (wanted.some((entry) => !keptKeys.has(entry.toLowerCase()))) return "limit";
  const entered = candidates.filter((entry) => normalizeChildInterest(entry).length > 0).length;
  return wanted.length < entered ? "duplicate" : null;
}

interface InterestsTagsInputProps {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  notice: InterestNotice | null;
  onNoticeChange: (notice: InterestNotice | null) => void;
  disabled?: boolean;
  /** Notki pod polem; Mantine łączy je z polem przez `aria-describedby`. */
  description?: ReactNode;
  "data-testid"?: string;
}

/**
 * Pole tematów (zainteresowań) z limitem 5, normalizacją wpisów jak na serwerze oraz
 * komunikatami o błędzie, powtórzeniu i limicie. Wspólne dla profilu dziecka i formularza lekcji.
 */
export function InterestsTagsInput({
  label,
  value,
  onChange,
  notice,
  onNoticeChange,
  disabled,
  description,
  "data-testid": testId,
}: InterestsTagsInputProps) {
  // kandydaci z `onPaste`/`onKeyDown`, które Mantine woła tuż przed `onChange` z uciętą listą
  const splitCandidates = useRef<string[] | null>(null);
  return (
    <TagsInput
      size="md"
      label={label}
      data-testid={testId}
      disabled={disabled}
      maxTags={MAX_CHILD_INTERESTS}
      splitChars={SPLIT_CHARS}
      description={description}
      // notki pod polem, przed komunikatem błędu
      inputWrapperOrder={["label", "input", "description", "error"]}
      error={interestFieldMessage(value, notice)}
      value={value}
      onPaste={(event) => {
        splitCandidates.current = event.clipboardData
          ? splitInterestCandidates(value, `${event.currentTarget.value}${event.clipboardData.getData("text/plain")}`)
          : null;
      }}
      onKeyDown={(event) => {
        // przecinek po wpisanym tekście rozbija go na tematy tak jak wklejenie
        const text = event.currentTarget.value;
        splitCandidates.current = SPLIT_CHARS.includes(event.key) && text.trim().length > 0 ? splitInterestCandidates(value, text) : null;
      }}
      onChange={(next) => {
        const parsed = parseInterestsInput(next);
        const candidates = splitCandidates.current;
        splitCandidates.current = null;
        // powtórzenie widoczne dopiero po normalizacji (np. podwójna spacja)
        onNoticeChange(candidates
          ? splitInterestNotice(candidates, next)
          : next.length > value.length && parsed.length < next.length ? "duplicate" : null);
        onChange(parsed);
      }}
      // dalsze pisanie zdejmuje komunikat; czyszczenie pola po dodaniu tematu go nie rusza
      onSearchChange={(text) => { if (text.length > 0) onNoticeChange(null); }}
      onDuplicate={() => onNoticeChange("duplicate")}
      // zdarzenie przy zwykłym opuszczeniu pustego pola nie jest próbą dodania tematu
      onMaxTags={(text) => { if (text.trim().length > 0) onNoticeChange("limit"); }}
    />
  );
}
