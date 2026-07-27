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

test("review day changes at 08:00 local time", () => {
  assert.equal(engine.reviewBusinessDate(new Date(2026, 6, 15, 7, 59)), "2026-07-14");
  assert.equal(engine.reviewBusinessDate(new Date(2026, 6, 15, 8, 0)), "2026-07-15");
  assert.equal(engine.millisecondsUntilReviewDayBoundary(new Date(2026, 6, 15, 7, 59)), 60_000);
  assert.equal(engine.millisecondsUntilReviewDayBoundary(new Date(2026, 6, 15, 8, 0)), 86_400_000);
});

test("postpone moves today, overdue, and future tasks forward by one real day", () => {
  assert.equal(engine.postponedTaskDate("2026-07-18", "2026-07-18"), "2026-07-19");
  assert.equal(engine.postponedTaskDate("2026-07-18", "2026-07-15"), "2026-07-19");
  assert.equal(engine.postponedTaskDate("2026-07-18", "2026-07-22"), "2026-07-23");
});
