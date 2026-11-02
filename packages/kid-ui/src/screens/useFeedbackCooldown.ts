import { useEffect, useRef, useState } from "react";
import { shouldIgnoreKeyboardShortcut } from "../exercises/useChoiceKeyboard";

/** Czas po zamontowaniu (albo zmianie `deps`), w którym przycisk ignoruje aktywację. */
export const FEEDBACK_COOLDOWN_MS = 300;

/**
 * Obsługa fokusu, cooldownu (300 ms) i ochrony przed event.repeat dla przycisków
 * w ekranach feedbacku i ujawnienia.
 *
 * `guardPointer` rozciąga cooldown na kliknięcia i dotyk: `onClick` ignoruje
 * aktywację w czasie cooldownu, a `coolingDown` (do `aria-disabled`) pokazuje
 * ją technologiom asystującym i Playwrightowi. Chroni przycisk, który pojawia
 * się w miejscu poprzedniego „Dalej” — drugie dotknięcie podwójnego dotyku nie
 * przeskakuje nowego ekranu (historyjka lekcji).
 */
export function useFeedbackCooldown<T extends HTMLButtonElement = HTMLButtonElement>(
  onAction: () => void,
  deps: unknown[] = [],
  autoFocus = false,
  guardPointer = false,
) {
  const buttonRef = useRef<T>(null);
  const mountTimeRef = useRef<number>(Date.now());
  const [coolingDown, setCoolingDown] = useState(guardPointer);

  useEffect(() => {
    mountTimeRef.current = Date.now();
    if (autoFocus) {
      buttonRef.current?.focus({ preventScroll: true });
    }
    if (!guardPointer) return undefined;
    setCoolingDown(true);
    const timer = setTimeout(() => setCoolingDown(false), FEEDBACK_COOLDOWN_MS);
    return () => clearTimeout(timer);
  }, deps);

  const inCooldown = () => Date.now() - mountTimeRef.current < FEEDBACK_COOLDOWN_MS;

  /** Kliknięcie przycisku: przy `guardPointer` ignorowane w czasie cooldownu. */
  const onClick = () => {
    if (guardPointer && inCooldown()) return;
    onAction();
  };

  // Obsługa Enter i Space na poziomie przycisku: blokada repeat i cooldownu < 300 ms
  const onKeyDown = (event: React.KeyboardEvent<T>) => {
    if (event.key === "Enter" || event.key === " " || event.code === "Space") {
      if (event.repeat || inCooldown()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
  };

  // Obsługa Enter na poziomie okna, gdy fokus przypadkowo znalazł się poza przyciskiem
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreKeyboardShortcut(event)) return;
      if (buttonRef.current?.disabled) return;

      if (event.key === "Enter") {
        if (event.repeat || inCooldown()) {
          event.preventDefault();
          return;
        }
        const active = typeof document !== "undefined" ? document.activeElement : null;
        if (active?.tagName === "BUTTON") {
          return;
        }
        if (active !== buttonRef.current) {
          event.preventDefault();
          onAction();
        }
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [onAction, ...deps]);

  return { buttonRef, onKeyDown, onClick, coolingDown };
}
