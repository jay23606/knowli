"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Badge, Group, Loader, NativeSelect, Paper, Stack, Text, Title } from "@mantine/core";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { messages, type ChildDto, type DeckSummaryDto, type ProgressDto } from "@learning/contracts";
import { errorMessage } from "./api";
import ProgressItems, { StatusLegend } from "./ProgressItems";
import MockTestReportPanel from "./MockTestReportPanel";
import { ChildPicker } from "./ChildPicker";
import { buildSkillRows } from "./build-skill-rows";
import { dueEntries, historyRows } from "./progress-lists";
import { ParentIcon, type ParentIconName } from "./ParentIcon";
import { orpc } from "./query-client";
import { formatFamilyDate } from "./family-date";
import "./progress-panel.css";

/**
 * Panel postępów (SPEC §25): filtrowanie dziecko × zestaw, liczby per
 * umiejętność, słowa do ćwiczeń, kierunkowe pomyłki i ostatnie odpowiedzi.
 * Wyniki wymowy pokazujemy z nazwą usługi — bez uśredniania skal.
 * Wygasłą sesję (401) obsługuje globalny handler zapytań.
 */

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

/** Minuty do najbliższej pełnej, nie mniej niż 1, gdy był jakikolwiek czas. */
function roundMinutes(seconds: number): number {
  return seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : 0;
}

function Card({ testId, title, icon, children, label }: {
  testId?: string;
  title?: string;
  icon?: ParentIconName;
  label?: string;
  children: ReactNode;
}) {
  return (
    <Paper component="section" withBorder radius="lg" p="md" data-testid={testId} aria-label={label}>
      {title && (
        <Title order={2} fz="md" mb="sm" className="pp-prog-cardtitle">
          {icon && <ParentIcon name={icon} />}
          {title}
        </Title>
      )}
      {children}
    </Paper>
  );
}

function ActivityCard({ progress }: { progress: ProgressDto }) {
  const { activity } = progress;
  const minutes = roundMinutes(activity.activeSeconds);
  const stats = [
    { id: "time", value: <>{minutes}<small> {messages.progress.activityMinutesUnit}</small></>, label: messages.progress.activityStatTime },
    { id: "days", value: activity.activeDays, label: messages.progress.activityStatDays },
    { id: "sessions", value: activity.sessions, label: messages.progress.activityStatSessions },
    { id: "answers", value: activity.answers, label: messages.progress.activityStatAnswers },
  ];
  return (
    <Card testId="progress-activity" title={fill(messages.progress.activityTitle, { days: activity.days })} icon="calendar">
      {activity.sessions === 0 ? <Text>{messages.progress.activityEmpty}</Text> : (
        <Stack gap="md">
          <Text data-testid="progress-activity-time">{fill(messages.progress.activityTime, { minutes })}</Text>
          {activity.daily.length > 0 && (
            <div className="pp-prog-daily" data-testid="progress-activity-daily">
              {activity.daily.map((day, index) => {
                const isToday = index === activity.daily.length - 1;
                const weekday = messages.progress.weekdaysShort[new Date(`${day.date}T12:00:00Z`).getUTCDay()] ?? "";
                const timeText = day.activeSeconds > 0
                  ? fill(messages.progress.activityMinutesShort, { minutes: roundMinutes(day.activeSeconds) })
                  : messages.progress.activityNoTime;
                const ariaText = day.activeSeconds > 0
                  ? fill(messages.progress.activityDailyAria, { day: weekday, date: day.date, time: timeText })
                  : fill(messages.progress.activityDailyAriaEmpty, { day: weekday, date: day.date });
                return (
                  <div
                    key={day.date}
                    role="group"
                    data-testid={`progress-activity-day-${day.date}`}
                    className="pp-prog-day"
                    data-active={day.activeSeconds > 0}
                    data-today={isToday}
                    title={ariaText}
                    aria-label={ariaText}
                  >
                    <span className="pp-prog-day-label">{isToday ? messages.progress.activityToday : weekday}</span>
                    <span className="pp-prog-day-time">{timeText}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="pp-prog-stats">
            {stats.map((stat) => (
              <div className="pp-prog-stat" key={stat.id} data-testid={`progress-stat-${stat.id}`}>
                <div className="pp-prog-stat-v">{stat.value}</div>
                <div className="pp-prog-stat-l">{stat.label}</div>
              </div>
            ))}
          </div>
          {activity.decks.length > 0 && (
            <ul className="pp-prog-plain">
              {activity.decks.map((deck) => (
                <li key={deck.deckId}>{fill(messages.progress.activityDeckRow, { title: deck.deckTitle, n: deck.sessions })}</li>
              ))}
            </ul>
          )}
        </Stack>
      )}
    </Card>
  );
}

function SkillsCard({ progress }: { progress: ProgressDto }) {
  return (
    <Card testId="progress-skills" title={messages.progress.masteryTitle} icon="target">
      {buildSkillRows(progress).map((row) => {
        const pct = (count: number) => (row.total === 0 ? 0 : (count / row.total) * 100);
        return (
          <div className="pp-prog-skill" key={row.skill}>
            <span className="pp-prog-skill-name">{messages.progress.skills[row.skill]}</span>
            <span
              className="pp-prog-bar"
              data-testid={`progress-skill-${row.skill}`}
              role="img"
              aria-label={fill(messages.progress.skillBarAria, {
                known: row.known,
                total: row.total,
                mastered: row.segments.mastered,
                needs: row.segments.needsConfirmation,
                practicing: row.segments.practicing,
                notAssessed: row.segments.notAssessed,
              })}
            >
              <span data-tone="mastered" style={{ width: `${pct(row.segments.mastered)}%` }} />
              <span data-tone="needs" style={{ width: `${pct(row.segments.needsConfirmation)}%` }} />
              <span data-tone="practicing" style={{ width: `${pct(row.segments.practicing)}%` }} />
              <span data-tone="none" style={{ width: `${pct(row.segments.notAssessed)}%` }} />
            </span>
            <span className="pp-prog-skill-val"><strong>{row.known}</strong>/{row.total}</span>
          </div>
        );
      })}
      <StatusLegend />
    </Card>
  );
}

export function PronunciationCard({ progress }: { progress: ProgressDto }) {
  const { pronunciation } = progress;
  return (
    <Card testId="progress-pronunciation" title={messages.progress.pronunciationTitle} icon="mic">
      {pronunciation.assessed ? (
        <Stack gap="xs">
          {pronunciation.latestScores.map((score) => {
            const tone = score.band === "correct" ? "success" : score.band === "partial" ? "warning" : "neutral";
            const bandLabel =
              score.band === "correct"
                ? messages.children.pronunciationBandCorrect
                : score.band === "partial"
                  ? messages.children.pronunciationBandPartial
                  : messages.children.pronunciationBandBelow;
            return (
              <div className="pp-prog-pron" key={score.target}>
                <span className="pp-prog-pron-word" lang="en-GB">{score.target}</span>
                <span
                  className="pp-prog-pron-track"
                  role="img"
                  aria-label={fill(messages.progress.pronunciationScoreAria, {
                    target: score.target,
                    score: score.score,
                    band: bandLabel,
                  })}
                >
                  <span style={{ width: `${Math.max(0, Math.min(100, score.score))}%` }} />
                </span>
                <span className="pp-prog-pron-v">{score.score}</span>
                <span className="pp-status-badge" data-tone={tone}>
                  {bandLabel}
                </span>
              </div>
            );
          })}
          <Text size="sm" className="pp-prog-note">
            <ParentIcon name="info" />
            {fill(messages.progress.pronunciationNote, { provider: pronunciation.latestScores[0]?.provider ?? "" })}
          </Text>
        </Stack>
      ) : (
        <Text>{messages.progress.pronunciationNotAssessed}</Text>
      )}
    </Card>
  );
}

export default function ProgressPanel({
  childrenList,
  decks,
}: {
  childrenList: ChildDto[];
  decks: DeckSummaryDto[];
}) {
  const published = useMemo(() => decks.filter((deck) => deck.publishedVersionId !== null), [decks]);
  const [childId, setChildId] = useState(childrenList[0]?.id ?? "");
  const [deckId, setDeckId] = useState(published[0]?.deckId ?? "");

  // Wybór ustawia się sam, gdy jest pusty albo wskazuje usunięte dziecko/zestaw.
  useEffect(() => {
    if (!childId || !childrenList.some((child) => child.id === childId)) setChildId(childrenList[0]?.id ?? "");
  }, [childrenList, childId]);
  useEffect(() => {
    if (!deckId || !published.some((deck) => deck.deckId === deckId)) setDeckId(published[0]?.deckId ?? "");
  }, [published, deckId]);

  // poprzedni raport zostaje na ekranie, dopóki nie dojdzie nowy (bez migania kart)
  const query = useQuery({
    ...orpc.progress.get.queryOptions({ input: { childId, deckId } }),
    enabled: childId !== "" && deckId !== "",
    placeholderData: keepPreviousData,
  });
  const progress = query.data;

  if (childrenList.length === 0 || published.length === 0) {
    return (
      <Stack gap="md">
        <Title order={1} fz={26}>{messages.progress.title}</Title>
        <Text>{messages.progress.empty}</Text>
      </Stack>
    );
  }

  // notka profilu obrazkowego dotyczy dziecka z pokazanego raportu (podczas
  // wczytywania nowego filtra na ekranie zostaje jeszcze poprzedni raport)
  const reportChild = progress ? childrenList.find((child) => child.id === progress.childId) : undefined;
  const due = progress ? dueEntries(progress.items) : [];

  return (
    <Stack gap="md" className="pp-prog" aria-busy={query.isFetching}>
      <Title order={1} fz={26}>{messages.progress.title}</Title>
      <Stack gap="sm">
        <ChildPicker
          childrenList={childrenList}
          value={childId}
          onChange={setChildId}
          label={messages.progress.childLabel}
          testId="progress-child"
          optionTestId="progress-child-option"
        />
        <Group gap="sm" align="flex-end" wrap="wrap">
          <NativeSelect
            size="md"
            id="progress-deck-select"
            label={messages.progress.deckLabel}
            data-testid="progress-deck"
            className="pp-prog-deck"
            value={deckId}
            onChange={(event) => setDeckId(event.currentTarget.value)}
            data={published.map((deck) => ({ value: deck.deckId, label: deck.title }))}
          />
          {progress?.testDate && (
            <Badge size="lg" variant="light" radius="sm" tt="none" leftSection={<ParentIcon name="calendar" />} className="pp-prog-testdate">
              {fill(messages.progress.testDateBadge, { date: formatFamilyDate(progress.testDate) })}
            </Badge>
          )}
        </Group>
      </Stack>
      {query.isFetching && (
        <Group gap="xs" role="status" data-testid="progress-loading">
          <Loader size="xs" />
          <Text size="sm">{messages.progress.loading}</Text>
        </Group>
      )}
      {query.isError && (
        <Alert color="red" variant="light" role="alert" data-testid="api-error">{errorMessage(query.error)}</Alert>
      )}

      {progress && (
        <>
          <MockTestReportPanel
            key={`${progress.childId}:${progress.deckId}`}
            childId={progress.childId}
            deckId={progress.deckId}
            currentDeckVersionId={published.find((deck) => deck.deckId === progress.deckId)?.publishedVersionId}
          />
          <ActivityCard progress={progress} />
          {reportChild?.canRead === false && (
            <Alert color="blue" variant="light" data-testid="progress-picture-note">{messages.progress.pictureProfileNote}</Alert>
          )}
          <div>
            <Title order={2} fz="lg" data-testid="progress-heading" className="pp-prog-heading">
              {progress.deckTitle} — {progress.childName}
            </Title>
            <Text size="sm" className="pp-prog-muted" data-testid="progress-test-date">
              {messages.progress.testDate}: {progress.testDate ?? messages.progress.noTestDate}
            </Text>
          </div>
          <SkillsCard progress={progress} />
          <ProgressItems items={progress.items} />
          <PronunciationCard progress={progress} />

          <Card testId="progress-due" title={messages.progress.dueForPractice} icon="flame">
            {due.length > 0 ? (
              <div className="pp-prog-duelist">
                {due.map((entry) => (
                  <span className="pp-prog-due" key={`${entry.skill}-${entry.target}`}>
                    <ParentIcon name="arrow-right" />
                    <span lang="en-GB">{entry.target}</span> <em>{messages.progress.skills[entry.skill].toLowerCase()}</em>
                  </span>
                ))}
              </div>
            ) : <Text>{messages.progress.dueEmpty}</Text>}
          </Card>

          <Card testId="progress-confusions" title={messages.progress.confusions} icon="shuffle">
            {progress.confusions.length > 0 ? (
              <ul className="pp-prog-rows">
                {progress.confusions.map((confusion) => (
                  <li key={`${confusion.expected}-${confusion.answered}`}>
                    <ParentIcon name="arrow-right" />
                    <span className="pp-prog-grow">{confusion.expected} → {confusion.answered}</span>
                    <span className="pp-status-badge" data-tone="neutral">{confusion.count}×</span>
                  </li>
                ))}
              </ul>
            ) : <Text>{messages.progress.confusionsEmpty}</Text>}
          </Card>

          <Card testId="progress-history" title={messages.progress.history} icon="history">
            {progress.history.length > 0 ? (
              <ul className="pp-prog-rows">
                {historyRows(progress.history.slice(0, 10), new Date()).map((row) => (
                  <li key={row.key}>
                    <span className="pp-prog-outcome" data-outcome={row.outcome}>
                      <ParentIcon name={row.outcome === "correct" ? "check" : row.outcome === "incorrect" ? "x" : "minus"} />
                      <span className="pp-prog-sr">{messages.progress.historyOutcome[row.outcome] ?? row.outcome}</span>
                    </span>
                    <span className="pp-prog-grow">
                      {row.source} → <strong>{row.target}</strong>
                      {row.supported && <span className="pp-prog-muted"> · {messages.progress.historyUnsupported}</span>}
                    </span>
                    <span className="pp-prog-muted pp-prog-when">{row.when}</span>
                  </li>
                ))}
              </ul>
            ) : <Text>{messages.progress.historyEmpty}</Text>}
          </Card>
        </>
      )}
    </Stack>
  );
}
