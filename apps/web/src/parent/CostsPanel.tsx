"use client";

import { useState, type ReactNode } from "react";
import { ActionIcon, Alert, Group, Loader, Paper, Stack, Table, Tabs, Text, Title } from "@mantine/core";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { messages, type ParentCostsDto } from "@learning/contracts";
import { errorMessage } from "./api";
import { compareMoney, currentMonth, fill, formatUnits, formatUsd, isPositive, monthLabel, pluralForm, shiftMonth } from "./cost-format";
import { ParentIcon } from "./ParentIcon";
import { plainClick } from "./plain-click";
import { routePath, type ParentRoute } from "./parent-routes";
import { orpc } from "./query-client";
import "./costs-panel.css";

type CostFeatureRow = ParentCostsDto["features"][number];
type CostDeckRow = ParentCostsDto["decks"][number];
type CostChildRow = ParentCostsDto["children"][number];

/** Stała funkcja `select` — TanStack nie przelicza jej przy każdym renderze. */
const selectBody = (response: { body: ParentCostsDto }): ParentCostsDto => response.body;

/** Kwota z „≈” przy szacunku i dopiskiem „+N bez ceny” przy wywołaniach bez ceny. */
function Amount({ value, estimated = false, unknownCalls = 0 }: { value: string; estimated?: boolean; unknownCalls?: number }) {
  return (
    <>
      <span>{estimated ? fill(messages.costs.approx, { amount: formatUsd(value) }) : formatUsd(value)}</span>
      {unknownCalls > 0 && (
        <Text component="span" size="xs" className="pp-costs-muted pp-costs-unknown" data-testid="costs-unknown">
          {fill(messages.costs.withoutPrice, { n: unknownCalls })}
        </Text>
      )}
    </>
  );
}

function CostTable({ minWidth, label, head, children }: { minWidth: number; label: string; head: ReactNode; children: ReactNode }) {
  return (
    <Table.ScrollContainer minWidth={minWidth} type="native">
      <Table aria-label={label} verticalSpacing="sm" horizontalSpacing="sm" className="pp-costs-table">
        <Table.Thead><Table.Tr>{head}</Table.Tr></Table.Thead>
        <Table.Tbody>{children}</Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

const Num = ({ children }: { children: ReactNode }) => <Table.Td className="pp-costs-num">{children}</Table.Td>;
const NumHead = ({ children }: { children: ReactNode }) => <Table.Th className="pp-costs-num">{children}</Table.Th>;

function EmptyMonth() {
  return <Text className="pp-costs-muted" data-testid="costs-empty">{messages.costs.empty}</Text>;
}

function FeaturesTab({ features }: { features: CostFeatureRow[] }) {
  const columns = messages.costs.columns;
  if (features.length === 0) return <EmptyMonth />;
  return (
    <CostTable
      minWidth={520}
      label={messages.costs.tabs.features}
      head={<><Table.Th>{columns.feature}</Table.Th><NumHead>{columns.calls}</NumHead><NumHead>{columns.units}</NumHead><NumHead>{columns.cost}</NumHead><NumHead>{columns.share}</NumHead></>}
    >
      {features.map((row) => (
        <Table.Tr key={row.feature} data-testid={`costs-feature-${row.feature}`}>
          <Table.Td>{messages.costs.featureNames[row.feature] ?? row.feature}</Table.Td>
          <Num>{row.calls}</Num>
          <Num>{formatUnits(row.feature, row)}</Num>
          <Num><Amount value={row.costUsd} estimated={row.estimated} unknownCalls={row.unknownCalls} /></Num>
          <Num>{fill(messages.costs.shareValue, { n: row.sharePercent })}</Num>
        </Table.Tr>
      ))}
    </CostTable>
  );
}

/** Talie malejąco po kwocie „razem”, a na końcu „Wspólne (interfejs)” i „Inne”, jeśli niezerowe. */
function deckRows(decks: CostDeckRow[]): CostDeckRow[] {
  const nonZero = (row: CostDeckRow) => isPositive(row.totalUsd) || isPositive(row.monthUsd) || row.unknownCalls > 0;
  const named = decks.filter((row) => row.bucket === "deck").sort((a, b) => compareMoney(b.totalUsd, a.totalUsd));
  const tail = (["shared_ui", "other"] as const).flatMap((bucket) => decks.filter((row) => row.bucket === bucket && nonZero(row)));
  return [...named, ...tail];
}

function DecksTab({ decks, onNavigate }: { decks: CostDeckRow[]; onNavigate: (route: ParentRoute) => void }) {
  const columns = messages.costs.columns;
  const rows = deckRows(decks);
  if (rows.length === 0) return <EmptyMonth />;
  const nameOf = (row: CostDeckRow): ReactNode => {
    if (row.bucket === "shared_ui") return messages.costs.sharedUi;
    if (row.bucket === "other") return messages.costs.other;
    const title = row.title ?? messages.costs.untitledDeck;
    if (row.deckId === null) return title;
    const route: ParentRoute = { section: "decks", deckId: row.deckId };
    return (
      <a
        href={routePath(route)}
        className="pp-costs-link"
        data-testid="costs-deck-link"
        onClick={(event) => {
          if (!plainClick(event)) return;
          event.preventDefault();
          onNavigate(route);
        }}
      >
        {title}
      </a>
    );
  };
  return (
    <Stack gap="sm">
      <CostTable
        minWidth={760}
        label={messages.costs.tabs.decks}
        head={<><Table.Th>{columns.deck}</Table.Th><Table.Th>{columns.kind}</Table.Th><NumHead>{columns.generation}</NumHead><NumHead>{columns.tts}</NumHead><NumHead>{columns.images}</NumHead><NumHead>{columns.lifetime}</NumHead><NumHead>{columns.month}</NumHead></>}
      >
        {rows.map((row, index) => (
          <Table.Tr key={row.deckId ?? `${row.bucket}-${index}`} data-testid={`costs-deck-row-${index}`}>
            <Table.Td className="pp-costs-name">{nameOf(row)}</Table.Td>
            <Table.Td>{row.kind === "lesson" ? messages.costs.kindLesson : row.kind === "vocabulary" ? messages.costs.kindVocabulary : ""}</Table.Td>
            <Num>{formatUsd(row.generationUsd)}</Num>
            <Num>{formatUsd(row.ttsUsd)}</Num>
            <Num>{formatUsd(row.imagesUsd)}</Num>
            <Num><Amount value={row.totalUsd} estimated={row.estimated} unknownCalls={row.unknownCalls} /></Num>
            <Num>{formatUsd(row.monthUsd)}</Num>
          </Table.Tr>
        ))}
      </CostTable>
      <Text size="sm" className="pp-costs-muted">{messages.costs.sharedAssetNote}</Text>
    </Stack>
  );
}

function ChildrenTab({ rows: all }: { rows: CostChildRow[] }) {
  const columns = messages.costs.columns;
  const rows = all.filter((row) => !row.deleted || isPositive(row.costUsd) || row.sessions > 0 || row.unknownCalls > 0);
  if (rows.length === 0) return <EmptyMonth />;
  const ordered = [...rows.filter((row) => !row.deleted), ...rows.filter((row) => row.deleted)];
  return (
    <Stack gap="sm">
      <CostTable
        minWidth={700}
        label={messages.costs.tabs.children}
        head={<><Table.Th>{columns.child}</Table.Th><NumHead>{columns.sessions}</NumHead><NumHead>{columns.cost}</NumHead><NumHead>{columns.perSession}</NumHead><NumHead>{columns.grading}</NumHead><NumHead>{columns.speech}</NumHead><NumHead>{columns.activity}</NumHead></>}
      >
        {ordered.map((row, index) => (
          <Table.Tr key={row.childId ?? "deleted"} data-testid={`costs-child-row-${index}`}>
            <Table.Td className="pp-costs-name">{row.deleted ? messages.costs.deletedProfiles : row.name ?? ""}</Table.Td>
            <Num>{row.sessions}</Num>
            <Num><Amount value={row.costUsd} estimated={row.estimated} unknownCalls={row.unknownCalls} /></Num>
            <Num>{row.perSessionUsd === null ? messages.costs.noValue : formatUsd(row.perSessionUsd)}</Num>
            <Num>{formatUsd(row.gradingUsd)}</Num>
            <Num>{formatUsd(row.speechUsd)}</Num>
            <Num>{formatUsd(row.activityUsd)}</Num>
          </Table.Tr>
        ))}
      </CostTable>
      <Text size="sm" className="pp-costs-muted">{messages.costs.childrenNote}</Text>
    </Stack>
  );
}

function Header({ report, month }: { report: ParentCostsDto; month: string }) {
  const { totals } = report;
  const costs = messages.costs;
  const notes: Array<[string, string]> = [];
  if (isPositive(totals.estimatedUsd)) notes.push(["estimated", fill(messages.costs.estimated, { amount: formatUsd(totals.estimatedUsd) })]);
  if (totals.unknownCalls > 0) notes.push(["unknown", fill(pluralForm(totals.unknownCalls, [costs.unknownCallsOne, costs.unknownCallsFew, costs.unknownCallsMany]), { n: totals.unknownCalls })]);
  if (totals.failedCalls > 0) notes.push(["failed", fill(pluralForm(totals.failedCalls, [costs.failedCallsOne, costs.failedCallsFew, costs.failedCallsMany]), { n: totals.failedCalls })]);
  if (totals.unscopedCalls > 0) notes.push(["unscoped", fill(pluralForm(totals.unscopedCalls, [costs.unscopedCallsOne, costs.unscopedCallsFew, costs.unscopedCallsMany]), { n: totals.unscopedCalls })]);
  return (
    <Paper withBorder radius="lg" p="md" data-testid="costs-header">
      <Text fz="xl" fw={700} data-testid="costs-total">
        {fill(messages.costs.total, { month: monthLabel(month), amount: formatUsd(totals.costUsd) })}
      </Text>
      {notes.map(([key, note]) => (
        <Text key={key} size="sm" className="pp-costs-muted" data-testid={`costs-note-${key}`}>{note}</Text>
      ))}
      <Text size="sm" className="pp-costs-muted" data-testid="costs-net-note">{messages.costs.netNote}</Text>
    </Paper>
  );
}

/**
 * Sekcja Koszty: miesiąc, suma i rozbicie kosztów usług AI według funkcji,
 * materiałów i dzieci (spec 2026-11-02-llm-cost-tracking §6). Tylko odczyt.
 */
export default function CostsPanel({ onNavigate }: { onNavigate: (route: ParentRoute) => void }) {
  const [now] = useState(() => currentMonth(new Date()));
  const [month, setMonth] = useState(now);
  // poprzedni miesiąc zostaje na ekranie, dopóki nie dojdzie nowy (bez migania)
  const query = useQuery({
    ...orpc.costs.get.queryOptions({ input: { month } }),
    select: selectBody,
    placeholderData: keepPreviousData,
  });
  const report = query.data;
  const everythingEmpty = report !== undefined
    && report.totals.calls === 0 && report.features.length === 0 && report.decks.length === 0 && report.children.length === 0;

  return (
    <Stack gap="md" className="pp-costs" aria-busy={query.isFetching}>
      <Title order={1} fz={26}>{messages.costs.title}</Title>
      <Group gap="xs" wrap="nowrap" justify="space-between" className="pp-costs-month">
        <ActionIcon
          variant="default"
          size={44}
          radius="md"
          aria-label={messages.costs.previousMonth}
          data-testid="costs-prev"
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          <ParentIcon name="chevron-left" />
        </ActionIcon>
        <Text fw={600} ta="center" data-testid="costs-month">{monthLabel(month)}</Text>
        <ActionIcon
          variant="default"
          size={44}
          radius="md"
          aria-label={messages.costs.nextMonth}
          data-testid="costs-next"
          disabled={month >= now}
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          <ParentIcon name="chevron-right" />
        </ActionIcon>
      </Group>
      {query.isPending && (
        <Group gap="sm" role="status" data-testid="costs-loading">
          <Loader size="sm" />
          <Text size="sm">{messages.costs.loading}</Text>
        </Group>
      )}
      {query.isError && <Alert color="red" variant="light" role="alert" data-testid="costs-error">{errorMessage(query.error)}</Alert>}
      {report && (
        <>
          <Header report={report} month={report.month} />
          {everythingEmpty ? (
            <EmptyMonth />
          ) : (
            <Tabs defaultValue="features" variant="outline">
              <Tabs.List>
                <Tabs.Tab value="features" className="pp-costs-tab" data-testid="costs-tab-features">{messages.costs.tabs.features}</Tabs.Tab>
                <Tabs.Tab value="decks" className="pp-costs-tab" data-testid="costs-tab-decks">{messages.costs.tabs.decks}</Tabs.Tab>
                <Tabs.Tab value="children" className="pp-costs-tab" data-testid="costs-tab-children">{messages.costs.tabs.children}</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="features" pt="md"><FeaturesTab features={report.features} /></Tabs.Panel>
              <Tabs.Panel value="decks" pt="md"><DecksTab decks={report.decks} onNavigate={onNavigate} /></Tabs.Panel>
              <Tabs.Panel value="children" pt="md"><ChildrenTab rows={report.children} /></Tabs.Panel>
            </Tabs>
          )}
        </>
      )}
    </Stack>
  );
}
