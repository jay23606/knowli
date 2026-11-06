import { Button, Input, createTheme, rem, type CSSVariablesResolver, type MantineColorsTuple } from "@mantine/core";

/**
 * Motyw Mantine panelu rodzica (plan 2026-10-29-parent-ui-mantine, faza 0).
 * Wartości wywodzą się z tokenów `pp-*` redesignu 2026-10-14 (§2.5): akcent
 * indygo `#4356e0` jest odcieniem 6 palety `brand`, promień kart 16 px,
 * typografia systemowa. Kid UI ma własny system tokenów i nie używa Mantine.
 */

/** Paleta akcentu: odcienie 0–5 mieszają `#4356e0` z bielą, 7–9 z czernią. */
const brand: MantineColorsTuple = [
  "#f4f5fd",
  "#e3e6fa",
  "#cad0f6",
  "#acb5f1",
  "#8a96ec",
  "#6978e6",
  "#4356e0",
  "#3b4cc5",
  "#3341aa",
  "#2b378f",
];

export const parentTheme = createTheme({
  primaryColor: "brand",
  // biały tekst na odcieniu 6: 5,76:1, na odcieniu 7: 6,94:1 (WCAG AA)
  primaryShade: { light: 6, dark: 7 },
  colors: { brand },
  autoContrast: true,
  defaultRadius: "lg",
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  headings: { fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  cursorType: "pointer",
  // klasy szerokości jak w Kid UI (Material 3): compact < 600 px, medium 600–839, expanded ≥ 840
  breakpoints: { xs: "37.5em", sm: "52.5em", md: "62em", lg: "75em", xl: "88em" },
  components: {
    // cel dotykowy ≥ 44 px dla domyślnego rozmiaru kontrolek panelu (Mantine md = 42 px)
    Button: Button.extend({
      vars: (_theme, props) => (props.size === "md" ? { root: { "--button-height": rem(44) } } : { root: {} }),
    }),
    Input: Input.extend({
      vars: (_theme, props) => (props.size === "md" ? { wrapper: { "--input-height": rem(44) } } : { wrapper: {} }),
    }),
  },
});

/**
 * Kolory stanów panelu (szkic, do sprawdzenia, opublikowany, archiwum, błąd,
 * lekcja) jako pary tekst/tło `--pp-status-*-fg` / `--pp-status-*-bg`
 * dla obu schematów. Kontrast tekstu na tle stanu ≥ 4,5:1 w obu schematach.
 */
const STATUS_COLORS = {
  success: { light: ["#157a47", "#dff2e8"], dark: ["#7ad6a5", "#173a29"] },
  warning: { light: ["#8a6212", "#fbf0cf"], dark: ["#e8c065", "#3d3115"] },
  info: { light: ["#2d5fc9", "#e5eefc"], dark: ["#93b4f5", "#1d2c4d"] },
  neutral: { light: ["#5c5f74", "#eef0f6"], dark: ["#b4b8cc", "#2e3040"] },
  danger: { light: ["#bf3a4a", "#fdebee"], dark: ["#f2a0aa", "#4a1f26"] },
  lesson: { light: ["#6b3fbf", "#f0eafc"], dark: ["#c3a6f5", "#33244f"] },
} as const;

function statusVariables(scheme: "light" | "dark"): Record<string, string> {
  return Object.fromEntries(
    Object.entries(STATUS_COLORS).flatMap(([name, schemes]) => {
      const [fg, bg] = schemes[scheme];
      return [
        [`--pp-status-${name}-fg`, fg],
        [`--pp-status-${name}-bg`, bg],
      ];
    }),
  );
}

export const parentCssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: statusVariables("light"),
  dark: statusVariables("dark"),
});
