"use client";

import type { MouseEvent, ReactNode } from "react";
import {
  ActionIcon,
  AppShell,
  Box,
  Button,
  Group,
  Menu,
  SegmentedControl,
  Text,
  useMantineColorScheme,
  type MantineColorScheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { messages } from "@learning/contracts";
import { ParentIcon, type ParentIconName } from "./ParentIcon";
import { TAB_SECTIONS, sectionPath, type ParentSection, type TabSection } from "./parent-routes";
import { plainClick } from "./plain-click";
import { useVirtualKeyboardOpen } from "./virtual-keyboard";
import "./parent-shell.css";

const SECTION_META: Record<TabSection, { label: string; icon: ParentIconName; testId: string }> = {
  decks: { label: messages.decks.title, icon: "layers", testId: "tab-decks" },
  sources: { label: messages.sources.tab, icon: "file-text", testId: "tab-sources" },
  children: { label: messages.children.title, icon: "users", testId: "tab-children" },
  progress: { label: messages.progress.title, icon: "trending-up", testId: "tab-progress" },
  "work-card": { label: messages.workCard.title, icon: "clipboard-check", testId: "tab-work-card" },
};

/** Klasa szerokości compact (< 600 px, plan §4): dolny pasek nawigacji. */
const COMPACT_QUERY = "(max-width: 37.49em)";
/** Niska wysokość (< 480 px, np. telefon poziomo): klawiatura zostawia mało miejsca nad sobą. */
const SHORT_QUERY = "(max-height: 29.99em)";
const SCHEME_ICON: Record<MantineColorScheme, ParentIconName> = { auto: "monitor", light: "sun", dark: "moon" };
const HEADER_HEIGHT ={ compact: 64, regular: 116 } as const;
const BOTTOM_NAV_HEIGHT = "calc(72px + env(safe-area-inset-bottom))";

function ColorSchemeControl() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const options = messages.parentShell.colorSchemeOptions;
  return (
    <SegmentedControl
      fullWidth
      aria-label={messages.parentShell.colorScheme}
      data-testid="color-scheme-control"
      value={colorScheme}
      onChange={(value) => setColorScheme(value as MantineColorScheme)}
      data={(["auto", "light", "dark"] as const).map((value) => ({ value, label: options[value] ?? value }))}
    />
  );
}

function Brand({ compact }: { compact: boolean }) {
  return (
    <Group gap="sm" wrap="nowrap" style={{ flexGrow: 1, minWidth: 0 }}>
      <span className="pp-shell-logo" aria-hidden="true">U!</span>
      <Box style={{ minWidth: 0 }}>
        <Text fw={700} fz={compact ? "md" : "lg"} lh={1.2}>{messages.app.name}</Text>
        <Text fz="xs" className="pp-shell-subtle">{messages.app.parentPanel}</Text>
      </Box>
    </Group>
  );
}

export interface ParentShellProps {
  section: ParentSection;
  onNavigate: (section: ParentSection) => void;
  onToLearning: () => void;
  onLogout: () => void;
  children: ReactNode;
}

/**
 * Rama panelu rodzica (plan 2026-10-29-parent-ui-mantine, faza 1; szkic
 * nawigacji zaakceptowany 2026-10-29): na telefonie dolny pasek sekcji
 * i menu ⋯ (Do nauki, Wygląd, Wyloguj), od 600 px zakładki pod nagłówkiem.
 * Sekcje są linkami z adresem — nawigację w panelu przejmuje `onNavigate`.
 */
export function ParentShell({ section, onNavigate, onToLearning, onLogout, children }: ParentShellProps) {
  const compact = useMediaQuery(COMPACT_QUERY, false, { getInitialValueInEffect: false }) ?? false;
  const short = useMediaQuery(SHORT_QUERY, false, { getInitialValueInEffect: false }) ?? false;
  // przy otwartej klawiaturze telefonu dolny pasek i przypięty pasek akcji edytora chowają się (data-keyboard-open)
  const keyboardOpen = useVirtualKeyboardOpen(compact || short);
  const { colorScheme } = useMantineColorScheme();

  const navLinks = (variant: "tab" | "bottom") =>
    TAB_SECTIONS.map((item) => {
      const meta = SECTION_META[item];
      const active = item === section;
      return (
        <a
          key={item}
          href={sectionPath(item)}
          className={variant === "tab" ? "pp-shell-tab" : "pp-shell-navitem"}
          data-testid={meta.testId}
          aria-current={active ? "true" : "false"}
          onClick={(event) => {
            if (!plainClick(event)) return;
            event.preventDefault();
            onNavigate(item);
          }}
        >
          {variant === "bottom" ? (
            <span className="pp-shell-pill"><ParentIcon name={meta.icon} /></span>
          ) : (
            <ParentIcon name={meta.icon} />
          )}
          <span className="pp-shell-label">{meta.label}</span>
        </a>
      );
    });

  const toCosts = (event: MouseEvent) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    onNavigate("costs");
  };

  /** „Koszty” to pozycja menu (nie szósta zakładka): wspólna dla obu klas szerokości. */
  const costsItem = (
    <Menu.Item
      component="a"
      href={sectionPath("costs")}
      leftSection={<ParentIcon name="wallet" />}
      data-testid="to-costs"
      aria-current={section === "costs" ? "page" : undefined}
      onClick={toCosts}
      mih={48}
    >
      {messages.costs.menuItem}
    </Menu.Item>
  );

  const toLearning = (event: MouseEvent) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    onToLearning();
  };

  return (
    <AppShell
      header={{ height: compact ? HEADER_HEIGHT.compact : HEADER_HEIGHT.regular }}
      footer={{ height: BOTTOM_NAV_HEIGHT, collapsed: !compact || keyboardOpen }}
      padding={0}
      data-keyboard-open={keyboardOpen ? "true" : undefined}
    >
      <AppShell.Header className="pp-shell-header">
        <div className="pp-shell-header-in">
          <Group h={HEADER_HEIGHT.compact} gap="sm" wrap="nowrap">
            <Brand compact={compact} />
            {compact ? (
              <Menu position="bottom-end" width={264} shadow="lg" radius="lg">
                <Menu.Target>
                  <ActionIcon variant="subtle" color="gray" size={48} radius="xl" aria-label={messages.parentShell.more} data-testid="parent-menu">
                    <ParentIcon name="more-vertical" className="pp-shell-more" />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {costsItem}
                  <Menu.Item component="a" href="/" leftSection={<ParentIcon name="play" />} data-testid="to-learning" onClick={toLearning} mih={48}>
                    {messages.auth.toLearning}
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Label>{messages.parentShell.colorScheme}</Menu.Label>
                  <Box px="xs" pb="xs"><ColorSchemeControl /></Box>
                  <Menu.Divider />
                  <Menu.Item leftSection={<ParentIcon name="log-out" />} data-testid="parent-logout" onClick={onLogout} mih={48} style={{ color: "var(--pp-status-danger-fg)" }}>
                    {messages.auth.logoutButton}
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            ) : (
              <Group gap={4} wrap="nowrap">
                <Button component="a" href="/" variant="subtle" color="gray" size="md" leftSection={<ParentIcon name="play" />} data-testid="to-learning" onClick={toLearning}>
                  {messages.auth.toLearning}
                </Button>
                <Menu position="bottom-end" width={260} shadow="lg" radius="lg">
                  <Menu.Target>
                    <ActionIcon variant="subtle" color="gray" size={44} radius="md" aria-label={messages.parentShell.colorScheme} data-testid="color-scheme-menu">
                      <ParentIcon name={SCHEME_ICON[colorScheme]} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Label>{messages.parentShell.colorScheme}</Menu.Label>
                    <Box px="xs" pb="xs"><ColorSchemeControl /></Box>
                  </Menu.Dropdown>
                </Menu>
                <Button variant="subtle" color="gray" size="md" leftSection={<ParentIcon name="log-out" />} data-testid="parent-logout" onClick={onLogout}>
                  {messages.auth.logoutButton}
                </Button>
                <Menu position="bottom-end" width={220} shadow="lg" radius="lg">
                  <Menu.Target>
                    <ActionIcon variant="subtle" color="gray" size={44} radius="md" aria-label={messages.parentShell.more} data-testid="parent-menu">
                      <ParentIcon name="more-vertical" className="pp-shell-more" />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>{costsItem}</Menu.Dropdown>
                </Menu>
              </Group>
            )}
          </Group>
          {!compact && (
            <nav className="pp-shell-tabs" aria-label={messages.parentShell.sections}>
              {navLinks("tab")}
            </nav>
          )}
        </div>
      </AppShell.Header>

      <AppShell.Main>
        {/* ta sama struktura elementów dla obu wariantów — zmiana wariantu
            (np. lista zestawów ↔ edytor) nie może przemontować sekcji */}
        <div>
          <div className="pp-shell-page">{children}</div>
        </div>
      </AppShell.Main>

      {compact && (
        <AppShell.Footer>
          <nav className="pp-shell-bottomnav" aria-label={messages.parentShell.sections}>
            {navLinks("bottom")}
          </nav>
        </AppShell.Footer>
      )}
    </AppShell>
  );
}
