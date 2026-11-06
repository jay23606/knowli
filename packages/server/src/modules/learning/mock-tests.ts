import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import { MockTestReportDtoSchema, MockTestSummaryDtoSchema, SkillStatusSchema, UuidSchema,
  type TestGoal, type TaskDto, type MockTestReportDto, type MockTestSummaryDto, type MockTestReportRow } from "@learning/contracts";
import type { Services } from "../../config";
import type { Tx } from "../../db/client";
import { itemRevisions, learningSessions, sessionTasks, deckVersions } from "../../db/schema";
import { buildMockTestPlan } from "../../domain/mock-test-plan";
import type { MockTestCandidate, MockTestPlanSnapshot } from "../../domain/mock-test-types";
import { computeTargetKey } from "../../domain/target-key";
import { payloadToItem } from "../materials";
import { writeSealedEvent } from "./events";
import { summarizeMockTestRows } from "../../domain/mock-test-report";
import { AppError } from "../../errors";
import { SESSION_TIME_LIMIT_MS, SESSION_TIME_PER_TASK_MS, sessionTimeLimitMs } from "../../domain/session-limits";
import { recordTaskSkillFacts } from "./skill-projections";

export async function closeMockTest(tx: Tx, services: Services, session: typeof learningSessions.$inferSelect, requestedState: "completed" | "ended"): Promise<MockTestReportDto> {
  const saved = MockTestReportDtoSchema.safeParse(session.context.mockTestReport);
  if (saved.success) return saved.data;
  const plan = session.mockTestPlan as MockTestPlanSnapshot;
  const [version] = await tx.select().from(deckVersions).where(eq(deckVersions.id, session.deckVersionId));
  const tasks = await tx.select().from(sessionTasks).where(eq(sessionTasks.sessionId, session.id));
  const tasksById = new Map(tasks.map(t => [t.id, t]));
  const grades = await tx.execute<{ task_id: string; skill: TestGoal; outcome: string; independent: boolean; reason: string | null; details: Record<string, unknown>; context: { assistance?: string[]; firstTry?: boolean } }>(sql`
    select t.id as task_id,a.skill,a.outcome,a.independent,a.reason,a.details,p.context
      from learning_app.session_tasks t join learning_app.attempts p on p.task_id=t.id and p.state='completed'
      join learning_app.assessments a on a.attempt_id=p.id where t.session_id=${session.id}`);
  const byTaskSkill = new Map(grades.rows.map(g => [`${g.task_id}:${g.skill}`, g]));
  const progress = await tx.execute<{ skill_version_id: string; status: string }>(sql`select skill_version_id,status from learning_app.child_skill_progress where child_id=${session.childId} and policy_id=${session.policyId}`);
  const statuses = new Map(progress.rows.map(p => [p.skill_version_id, p.status]));
  const rows: MockTestReportRow[] = [];
  for (const item of plan.scope) for (const skill of plan.testGoals) {
    const slot = plan.slots.find(s => s.itemId === item.itemId && s.goals.includes(skill));
    const task = slot ? tasksById.get(slot.taskId) : undefined;
    const grade = slot ? byTaskSkill.get(`${slot.taskId}:${skill}`) : undefined;
    const status = SkillStatusSchema.safeParse(statuses.get(item.skills[skill] ?? ""));
    let outcome: MockTestReportRow["outcome"] = "not_tested";
    let independenceReason: MockTestReportRow["independenceReason"] = null;
    let reason: string | null = slot ? "interrupted" : item.unavailable[skill] ?? "outside_portion";
    if (task?.state === "skipped") { outcome = "skipped"; reason = "skipped"; }
    else if (grade) {
      outcome = grade.outcome === "unassessed" ? "unassessed" : grade.outcome as "correct" | "incorrect";
      reason = grade.reason;
      if (!grade.independent && (outcome === "correct" || outcome === "incorrect")) independenceReason = grade.context.assistance?.length ? "assisted" : grade.context.firstTry === false ? "not_first_try" : "recent_exposure";
      if (skill === "spelling" && (grade.details.spelling as { capitalizationOnlyDefect?: boolean } | undefined)?.capitalizationOnlyDefect) reason = "capitalization";
    }
    rows.push({ itemId: item.itemId, source: item.source, target: item.target, skill, outcome, independent: grade?.independent ?? false,
      reason, independenceReason, masteryStatus: status.success ? status.data : "not_assessed" });
  }
  const complete = plan.slots.every(s => { const t = tasksById.get(s.taskId); return t && t.state !== "issued"; });
  const endedAt = session.endedAt ?? services.clock.now();
  const state = complete ? "completed" : requestedState === "completed" ? "ended" : requestedState;
  const report = MockTestReportDtoSchema.parse({ sessionId: session.id, childId: session.childId, deckId: session.deckId,
    deckTitle: version!.title, deckVersionNumber: version!.versionNumber,
    deckVersionId: session.deckVersionId, testDate: plan.testDate, testGoals: plan.testGoals, requestedTaskCount: plan.requestedTaskCount,
    taskBudget: session.taskBudget, state, complete, startedAt: session.startedAt.toISOString(), endedAt: endedAt.toISOString(),
    rows, skills: summarizeMockTestRows(rows, plan.testGoals) });
  await tx.update(learningSessions).set({ state, endedAt, context: { ...session.context, mockTestReport: report } }).where(eq(learningSessions.id, session.id));
  return report;
}

async function terminalSession(tx: Tx, services: Services, sessionId: string) {
  const [session] = await tx.select().from(learningSessions).where(eq(learningSessions.id, UuidSchema.parse(sessionId))).for("update");
  if (!session || session.mode !== "mock_test") throw new AppError("not_found");
  if (session.state === "active" && services.clock.now().getTime() - session.startedAt.getTime() <= sessionTimeLimitMs(session.taskBudget)) {
    throw new AppError("conflict", { message: "Omówienie jest dostępne po zakończeniu kartkówki." });
  }
  const report = await closeMockTest(tx, services, session, "ended");
  return { session, report };
}

export async function getMockTestReport(services: Services, sessionId: string): Promise<MockTestReportDto> {
  return services.db.transaction(async tx => (await terminalSession(tx, services, sessionId)).report);
}

export async function readMockTestSummary(services: Services, sessionId: string): Promise<MockTestSummaryDto> {
  return services.db.transaction(async tx => {
    const { session, report } = await terminalSession(tx, services, sessionId);
    const vocabPlan = session.mockTestPlan as MockTestPlanSnapshot;
    const tasks = await tx.select().from(sessionTasks).where(eq(sessionTasks.sessionId, session.id)).orderBy(asc(sessionTasks.ordinal));
    const solutions: MockTestSummaryDto["solutions"] = [];
    for (const task of tasks) {
      const slot = vocabPlan.slots[task.ordinal]!;
      const item = vocabPlan.scope.find(i => i.itemId === slot.itemId)!;
      await writeSealedEvent(tx, { childId: session.childId, taskId: task.id, itemId: item.itemId, kind: "feedback_issued",
        stepId: `${session.id}:review:${task.ordinal}`, occurredAt: services.clock.now(), exposures: [slot.targetKey] });
      solutions.push({ taskId: task.id, source: item.source, target: item.target, audioAssetId: slot.audioAssetId,
        results: slot.goals.map(skill => ({ skill, outcome: report.rows.find(r => r.itemId === slot.itemId && r.skill === skill)!.outcome })) });
    }
    return MockTestSummaryDtoSchema.parse({ sessionId: session.id, deckId: session.deckId, state: report.state, complete: report.complete,
      taskBudget: session.taskBudget, answeredCount: tasks.filter(t => t.state !== "issued").length, solutions });
  });
}

/** SQL-owy odpowiednik `sessionTimeLimitMs(task_budget)`: kartkówka po swoim limicie czasu. */
export function mockTestTimedOut(now: Date) {
  return sql`${learningSessions.startedAt} < ${now.toISOString()}::timestamptz
    - interval '1 millisecond' * greatest(${SESSION_TIME_LIMIT_MS}, ${learningSessions.taskBudget} * ${SESSION_TIME_PER_TASK_MS})`;
}

export async function listMockTests(services: Services, childId: string, deckId: string): Promise<MockTestReportDto[]> {
  const rows = await services.db.select({ id: learningSessions.id }).from(learningSessions)
    .where(and(eq(learningSessions.childId, UuidSchema.parse(childId)), eq(learningSessions.deckId, UuidSchema.parse(deckId)),
      eq(learningSessions.mode, "mock_test"), or(ne(learningSessions.state, "active"), mockTestTimedOut(services.clock.now()))))
    .orderBy(desc(learningSessions.startedAt), desc(learningSessions.id)).limit(20);
  const result: MockTestReportDto[] = [];
  for (const row of rows) result.push(await getMockTestReport(services, row.id));
  return result;
}

export async function createMockTestPlan(tx: Tx, services: Services, input: { childId: string; deckVersionId: string; policyId: string; testGoals: TestGoal[]; testDate: string | null; requestedTaskCount: number }): Promise<MockTestPlanSnapshot> {
  const revisions = await tx.select().from(itemRevisions).where(eq(itemRevisions.deckVersionId, input.deckVersionId)).orderBy(asc(itemRevisions.position));
  const candidates: MockTestCandidate[] = [];
  for (const r of revisions) {
    const item = payloadToItem(r.payload);
    const data = await tx.execute<{ skill: TestGoal; skill_version_id: string; status: string | null; checked: boolean; known: boolean; audio: string | null }>(sql`
      select s.skill,s.skill_version_id,p.status,
        exists(select 1 from learning_app.assessments a where a.child_id=${input.childId} and a.skill_version_id=s.skill_version_id and a.skill=s.skill and a.independent and a.outcome<>'unassessed') as checked,
        exists(select 1 from learning_app.learning_events e
          join learning_app.session_tasks t on t.id=e.task_id
          join learning_app.item_revision_skills os on os.item_revision_id=t.item_revision_id and os.skill='recall'
          join learning_app.item_revision_skills cs on cs.item_revision_id=${r.id} and cs.skill='recall' and cs.skill_version_id=os.skill_version_id
          join learning_app.event_exposures x on x.event_id=e.id
          where e.child_id=${input.childId} and e.item_id=${r.itemId} and e.sealed and x.target_key=${computeTargetKey(item.target, item.locales.target)}) as known,
        (select ra.asset_id from learning_app.revision_assets ra join learning_app.media_assets m on m.id=ra.asset_id
          where ra.item_revision_id=${r.id} and ra.role='target_audio' and ra.state='approved' and m.state='ready' limit 1) as audio
      from learning_app.item_revision_skills s left join learning_app.child_skill_progress p on p.child_id=${input.childId} and p.policy_id=${input.policyId} and p.skill_version_id=s.skill_version_id
      where s.item_revision_id=${r.id} and s.skill in ('recall','spelling','listening')`);
    candidates.push({ itemId: r.itemId, itemRevisionId: r.id, position: r.position, source: item.source, target: item.target,
      targetKey: computeTargetKey(item.target, item.locales.target), acceptedAnswers: item.acceptedAnswers, known: data.rows[0]?.known ?? false,
      audioAssetId: data.rows[0]?.audio ?? null, skills: Object.fromEntries(data.rows.map(s => [s.skill, { skillVersionId: s.skill_version_id,
        priority: !s.checked ? 0 : s.status === "practicing" || s.status === "needs_reconfirmation" ? 1 : 2 }])) });
  }
  return buildMockTestPlan({ ...input, candidates, newId: randomUUID });
}

export async function issueMockTestTask(tx: Tx, services: Services, session: typeof learningSessions.$inferSelect): Promise<TaskDto | null> {
  const tasks = await tx.select().from(sessionTasks).where(eq(sessionTasks.sessionId, session.id)).orderBy(asc(sessionTasks.ordinal));
  const active = tasks.find(t => t.state === "issued");
  if (active) return { taskId: active.id, sessionId: session.id, ordinal: active.ordinal, exerciseType: active.exerciseType as TaskDto["exerciseType"],
    direction: null, state: "issued", prompt: active.publicPrompt as TaskDto["prompt"], remainingAssessed: session.taskBudget - active.ordinal };
  const slot = (session.mockTestPlan as MockTestPlanSnapshot).slots[tasks.length];
  if (!slot) return null;
  await tx.insert(sessionTasks).values({ id: slot.taskId, sessionId: session.id, childId: session.childId, deckVersionId: session.deckVersionId,
    itemRevisionId: slot.itemRevisionId, ordinal: tasks.length, exerciseType: slot.exerciseType, direction: null, state: "issued",
    publicPrompt: slot.prompt as unknown as Record<string, unknown>, answerKey: slot.answerKey as unknown as Record<string, unknown>,
    context: { reason: "mock-test" }, issuedAt: services.clock.now() });
  await recordTaskSkillFacts(tx, {
    childId: session.childId,
    itemRevisionId: slot.itemRevisionId,
    policyId: session.policyId,
    exerciseType: slot.exerciseType,
    issuedAt: services.clock.now(),
  });
  await writeSealedEvent(tx, { childId: session.childId, taskId: slot.taskId, itemId: slot.itemId, kind: "prompt_issued",
    stepId: `${slot.taskId}:prompt`, occurredAt: services.clock.now(), exposures: slot.exerciseType === "listening" ? [slot.targetKey] : [] });
  return { taskId: slot.taskId, sessionId: session.id, ordinal: tasks.length, exerciseType: slot.exerciseType,
    direction: null, state: "issued", prompt: slot.prompt, remainingAssessed: session.taskBudget - tasks.length };
}
