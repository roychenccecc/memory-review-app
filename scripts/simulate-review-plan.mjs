import { readFileSync } from "node:fs";
import "../review-engine.js";

const engine = globalThis.ReviewEngine;
const [backupPath, startDay] = process.argv.slice(2);
if (!backupPath || !/^\d{4}-\d{2}-\d{2}$/.test(startDay || "")) {
  throw new Error("Usage: node scripts/simulate-review-plan.mjs BACKUP.json YYYY-MM-DD");
}
const backup = JSON.parse(readFileSync(backupPath, "utf8"));
const examDate = backup.settings?.examDate;
if (!examDate || !Array.isArray(backup.tasks) || !Array.isArray(backup.study)
  || !Array.isArray(backup.mistakes) || !Array.isArray(backup.logs)) {
  throw new Error("The backup lacks the records needed for a simulation.");
}

function simulate({ improvement, restEverySeventhDay }) {
  const items = new Map([...backup.study.map((item) => [
    `study:${item.id}`, { ...item, sourceType: "study" },
  ]), ...backup.mistakes.map((item) => [
    `mistake:${item.id}`, { ...item, sourceType: "mistake" },
  ])]);
  const logs = new Map();
  for (const log of backup.logs) {
    const key = `${log.sourceType}:${log.sourceId}`;
    if (!logs.has(key)) logs.set(key, []);
    logs.get(key).push({ date: log.date, score: Number(log.recallPercent ?? log.afterScore) });
  }
  for (const rows of logs.values()) rows.sort((a, b) => b.date.localeCompare(a.date));
  const pending = new Map();
  for (const task of backup.tasks.filter((row) => row.status === "pending" && !row.isCram)) {
    const key = `${task.sourceType}:${task.sourceId}`;
    if (!items.has(key)) continue;
    const old = pending.get(key);
    if (!old || (task.earliestDate || task.scheduledDate) < (old.earliestDate || old.scheduledDate)) {
      pending.set(key, { ...task, earliestDate: task.earliestDate || task.scheduledDate });
    }
  }
  const initialFirst = [...pending].filter(([key]) => {
    const item = items.get(key);
    return item.sourceType === "study" && (item.studyKind || "new") === "new"
      && !item.lastReviewedAt && !logs.get(key)?.length;
  }).length;
  const initialOverdue = [...pending.values()].filter((task) => task.earliestDate < startDay).length;
  const weekly = new Map();
  let completedStudy = 0;
  let completedMistake = 0;
  let completedFirst = 0;
  let lastFirstDay = "";
  let maximumOverdueDays = 0;
  let dayIndex = 0;

  for (let day = startDay; day <= examDate; day = engine.addDays(day, 1), dayIndex += 1) {
    const week = Math.floor(dayIndex / 7) + 1;
    if (!weekly.has(week)) weekly.set(week, { week, from: day, study: 0, mistake: 0, first: 0 });
    const available = [...pending].map(([key, task]) => {
      const item = items.get(key);
      const history = logs.get(key) || [];
      const first = item.sourceType === "study" && (item.studyKind || "new") === "new"
        && !item.lastReviewedAt && !history.length;
      const latest = history[0]?.score;
      const delay = engine.recommendedIntervalDays(30, history);
      const riskRank = first ? 3 : latest < 50 ? 0 : latest < 70 ? 1 : delay <= 7 ? 2 : 4;
      return { ...task, isFirstReview: first, studyDate: item.date || item.createdAt?.slice(0, 10), riskRank };
    });
    if (engine.diffDays(day, examDate) <= Number(backup.settings.cramWindow || 14)) {
      const cram = [...items].filter(([key, item]) => {
        const history = logs.get(key) || [];
        if (item.sourceType === "study" && (item.studyKind || "new") === "new"
          && !item.lastReviewedAt && !history.length) return false;
        const lastDate = item.lastReviewedAt || item.date || item.createdAt?.slice(0, 10) || day;
        const score = engine.decayedMemoryScore(item.memoryScore ?? 70, lastDate, day);
        return engine.diffDays(lastDate, day) >= 7 && (score < 70 || engine.diffDays(lastDate, day) > 30);
      }).sort((a, b) => (a[1].memoryScore ?? 70) - (b[1].memoryScore ?? 70))
        .slice(0, Number(backup.settings.dailyCramLimit || 20));
      for (const [key, item] of cram) {
        const existing = available.find((task) => `${task.sourceType}:${task.sourceId}` === key);
        if (existing) {
          if (!(existing.postponedUntil && existing.postponedUntil > day)) {
            existing.earliestDate = engine.minDate(existing.earliestDate, day);
          }
        } else {
          available.push({ id: `cram-${key}`, sourceType: item.sourceType, sourceId: item.id,
            earliestDate: day, riskRank: 2 });
        }
      }
    }
    const today = engine.scheduleReviewTasks(available, {
      today: day, examDate, studyLimit: Number(backup.settings.dailyReviewLimit || 4),
      mistakeLimit: Number(backup.settings.dailyMistakeReviewLimit || 2),
    }).filter((task) => task.scheduledDate === day);
    if (!restEverySeventhDay || dayIndex % 7 !== 6) {
      for (const task of today) {
        const key = `${task.sourceType}:${task.sourceId}`;
        const item = items.get(key);
        const history = logs.get(key) || [];
        const first = task.isFirstReview;
        const score = Math.min(100, (history[0]?.score ?? item.lastRecallPercent ?? 75) + improvement);
        const interval = engine.intervalStateAfterReview(item, score, Number(item.memoryScore ?? 70));
        item.currentIntervalIndex = interval.index;
        item.currentInterval = interval.interval;
        item.lastReviewedAt = day;
        item.lastRecallPercent = score;
        const updated = [{ date: day, score }, ...history];
        logs.set(key, updated);
        item.memoryScore = engine.aggregateReviewScore(item.sourceType, updated.map((row) => row.score));
        const target = engine.addDays(day, engine.recommendedIntervalDays(interval.interval, updated));
        pending.delete(key);
        if (target <= examDate) pending.set(key, {
          id: task.id, sourceType: item.sourceType, sourceId: item.id, earliestDate: target,
        });
        if (item.sourceType === "study") {
          completedStudy += 1;
          weekly.get(week).study += 1;
          if (first) {
            completedFirst += 1;
            lastFirstDay = day;
            weekly.get(week).first += 1;
          }
        } else {
          completedMistake += 1;
          weekly.get(week).mistake += 1;
        }
      }
    }
    for (const task of pending.values()) {
      if (task.earliestDate < day) {
        maximumOverdueDays = Math.max(maximumOverdueDays, engine.diffDays(task.earliestDate, day));
      }
    }
    weekly.get(week).remainingOverdue = [...pending.values()]
      .filter((task) => task.earliestDate <= day).length;
  }
  return {
    scenario: improvement ? "score-improves-five-per-review" : restEverySeventhDay ? "six-days-per-week" : "score-holds",
    initialFirst, initialOverdue, completedStudy, completedMistake, completedFirst, lastFirstDay,
    maximumOverdueDays,
    remainingDueByExam: [...pending.values()].filter((task) => task.earliestDate <= examDate).length,
    weekly: [...weekly.values()],
  };
}

console.log(JSON.stringify({ startDay, examDate, scenarios: [
  simulate({ improvement: 0, restEverySeventhDay: false }),
  simulate({ improvement: 5, restEverySeventhDay: false }),
  simulate({ improvement: 0, restEverySeventhDay: true }),
] }, null, 2));
