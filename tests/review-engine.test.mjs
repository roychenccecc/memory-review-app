import test from "node:test";
import assert from "node:assert/strict";

await import("../review-engine.js");

const engine = globalThis.ReviewEngine;

test("study score uses the latest ten-review average", () => {
  assert.equal(engine.aggregateReviewScore("study", [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0]), 55);
});

test("mistake score gives the latest review half of the weight", () => {
  assert.equal(engine.aggregateReviewScore("mistake", [90, 60]), 75);
  assert.equal(engine.aggregateReviewScore("mistake", [80]), 80);
});

test("section score follows knowledge importance weights", () => {
  assert.equal(engine.weightedSectionScore([
    { score: 70, weight: 2 },
    { score: 90, weight: 5 },
  ]), 84);
});

test("review interval advances at 70 percent and protects low recalls", () => {
  const item = { currentIntervalIndex: 2 };
  assert.deepEqual(engine.intervalStateAfterReview(item, 85, 85), { index: 3, interval: 7 });
  assert.deepEqual(engine.intervalStateAfterReview(item, 70, 45), { index: 3, interval: 7 });
  assert.deepEqual(engine.intervalStateAfterReview(item, 55, 45), { index: 1, interval: 2 });
  assert.deepEqual(engine.intervalStateAfterReview(item, 29, 85), { index: 0, interval: 1 });
});

test("today reviewed plus pending reviews never exceeds four by default", () => {
  const tasks = Array.from({ length: 6 }, (_, index) => ({
    id: `task-${index}`,
    earliestDate: "2026-07-15",
    scheduledDate: "2026-07-15",
    priority: 100 - index,
  }));
  const queued = engine.applyDailyCapacity(tasks, {
    today: "2026-07-15",
    reviewedCount: 3,
  });
  assert.equal(queued.filter((task) => task.scheduledDate === "2026-07-15").length, 1);
  assert.equal(queued.filter((task) => task.scheduledDate === "2026-07-16").length, 4);
  assert.equal(queued.filter((task) => task.scheduledDate === "2026-07-17").length, 1);
  assert.equal(queued[0].id, "task-0");
});

test("unreviewed new study is identifiable for a reserved study slot", () => {
  const tasks = [
    { id: "first", sourceType: "study", sourceId: "new", status: "pending", earliestDate: "2026-09-16" },
    { id: "old", sourceType: "study", sourceId: "reviewed", status: "pending", earliestDate: "2026-09-16" },
    { id: "kind-review", sourceType: "study", sourceId: "review-kind", status: "pending", earliestDate: "2026-09-17" },
    { id: "mistake", sourceType: "mistake", sourceId: "mistake", status: "pending", earliestDate: "2026-09-17" },
  ];
  const studies = [
    { id: "new", studyKind: "new" },
    { id: "reviewed", studyKind: "new" },
    { id: "review-kind", studyKind: "review" },
  ];
  const logs = [{ sourceType: "study", sourceId: "reviewed", date: "2026-09-16" }];
  const { firstReview, formal } = engine.partitionFirstReviewTasks(tasks, studies, logs);
  assert.deepEqual(firstReview.map((task) => task.id), ["first"]);
  assert.deepEqual(formal.map((task) => task.id), ["old", "kind-review", "mistake"]);
  const queued = engine.scheduleReviewTasks([
    { ...firstReview[0], isFirstReview: true, studyDate: "2026-08-01" },
    ...formal,
  ], { today: "2026-09-17", studyLimit: 2, mistakeLimit: 1 });
  assert.deepEqual(queued.filter((task) => task.scheduledDate === "2026-09-17")
    .map((task) => task.id), ["first", "old", "mistake"]);
});

test("study and mistake limits are independent and quick-first counts as study", () => {
  const tasks = [
    ...Array.from({ length: 5 }, (_, n) => ({
      id: `study-${n}`, sourceType: "study", earliestDate: "2026-09-16",
      isFirstReview: n === 0, studyDate: "2026-08-01", riskRank: n === 0 ? 3 : 4,
    })),
    ...Array.from({ length: 4 }, (_, n) => ({
      id: `mistake-${n}`, sourceType: "mistake", earliestDate: "2026-09-16", riskRank: 4,
    })),
  ];
  const queued = engine.scheduleReviewTasks(tasks, {
    today: "2026-09-17", studyLimit: 4, mistakeLimit: 2,
    reviewedStudyCount: 1, reviewedMistakeCount: 1,
  });
  const today = queued.filter((task) => task.scheduledDate === "2026-09-17");
  assert.equal(today.filter((task) => task.sourceType === "study").length, 3);
  assert.equal(today.filter((task) => task.sourceType === "mistake").length, 1);
  assert.ok(today.some((task) => task.id === "study-0"));
  assert.equal(queued.length, tasks.length);
  assert.ok(queued.some((task) => task.earliestDate === "2026-09-16" && task.scheduledDate > "2026-09-17"));
});

test("one oldest first review and one established overdue review are reserved", () => {
  const tasks = [
    { id: "newer", sourceType: "study", isFirstReview: true, studyDate: "2026-08-18", earliestDate: "2026-09-01", riskRank: 3 },
    { id: "oldest", sourceType: "study", isFirstReview: true, studyDate: "2026-08-01", earliestDate: "2026-09-01", riskRank: 3 },
    { id: "formal", sourceType: "study", earliestDate: "2026-09-05", riskRank: 4 },
    { id: "urgent", sourceType: "study", earliestDate: "2026-09-17", riskRank: 0 },
  ];
  const queued = engine.scheduleReviewTasks(tasks, { today: "2026-09-17", studyLimit: 3 });
  assert.deepEqual(queued.filter((task) => task.scheduledDate === "2026-09-17").map((task) => task.id),
    ["oldest", "formal", "urgent"]);
});

test("retests cap only the next target, not the interval state", () => {
  const rows = (a, b = null) => [
    { date: "2026-09-17", score: a },
    ...(b == null ? [] : [{ date: "2026-09-15", score: b }]),
  ];
  assert.equal(engine.recommendedIntervalDays(30, rows(49)), 1);
  assert.equal(engine.recommendedIntervalDays(30, rows(60)), 3);
  assert.equal(engine.recommendedIntervalDays(30, rows(74)), 7);
  assert.equal(engine.recommendedIntervalDays(30, rows(78, 79)), 7);
  assert.equal(engine.recommendedIntervalDays(30, rows(78, 82)), 30);
  assert.equal(engine.recommendedIntervalDays(4, rows(74)), 4);
  assert.equal(engine.recommendedIntervalDays(30, [rows(78)[0], { date: "2026-09-17", score: 70 }]), 30);
  assert.equal(engine.recommendedIntervalDays(30, [{ date: "2026-09-18", score: null }]), 30);
  assert.equal(engine.recommendedIntervalDays(30, [{ date: "2026-09-18", score: "" }]), 30);
  assert.deepEqual(engine.intervalStateAfterReview({ currentIntervalIndex: 4 }, 74, 74),
    { index: 5, interval: 30 });
});

test("postponed eligibility and exam day bound are respected", () => {
  const queued = engine.scheduleReviewTasks([
    { id: "postponed", sourceType: "study", earliestDate: "2026-09-19", riskRank: 0 },
    { id: "late", sourceType: "study", earliestDate: "2026-09-20", riskRank: 0 },
  ], { today: "2026-09-17", examDate: "2026-09-19" });
  assert.deepEqual(queued.map((task) => [task.id, task.scheduledDate]), [["postponed", "2026-09-19"]]);
});

test("a restored study with lastReviewedAt is never treated as unreviewed", () => {
  const task = { id: "restored", sourceType: "study", sourceId: "study", status: "pending" };
  const result = engine.partitionFirstReviewTasks([task], [{ id: "study", lastReviewedAt: "2026-09-16" }]);
  assert.equal(result.firstReview.length, 0);
  assert.equal(result.formal.length, 1);
});

test("knowledge score combines learning and penalized mistakes", () => {
  const leaf = engine.leafKnowledgeSummary([90], [80, 80]);
  assert.deepEqual(leaf, {
    score: 84,
    studyScore: 90,
    mistakeBaseScore: 80,
    mistakeScore: 74,
    mistakeCount: 2,
  });
  const parent = engine.parentKnowledgeSummary([
    { score: 90, importance: "veryHigh", mistakeCount: 1 },
    { score: 60, importance: "low", mistakeCount: 2 },
  ]);
  assert.deepEqual(parent, { score: 85, mistakeCount: 3 });
});

test("review day changes at 03:00 local time", () => {
  assert.equal(engine.reviewBusinessDate(new Date(2026, 6, 15, 2, 59)), "2026-07-14");
  assert.equal(engine.reviewBusinessDate(new Date(2026, 6, 15, 3, 0)), "2026-07-15");
  assert.equal(engine.millisecondsUntilReviewDayBoundary(new Date(2026, 6, 15, 2, 59)), 60_000);
  assert.equal(engine.millisecondsUntilReviewDayBoundary(new Date(2026, 6, 15, 3, 0)), 86_400_000);
});

test("postpone moves today, overdue, and future tasks forward by one real day", () => {
  assert.equal(engine.postponedTaskDate("2026-07-18", "2026-07-18"), "2026-07-19");
  assert.equal(engine.postponedTaskDate("2026-07-18", "2026-07-15"), "2026-07-19");
  assert.equal(engine.postponedTaskDate("2026-07-18", "2026-07-22"), "2026-07-23");
});
