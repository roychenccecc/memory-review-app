import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
const indexSource = await readFile(new URL("../index.html", import.meta.url), "utf8");
const syncSource = await readFile(new URL("../v52-today-sync.js", import.meta.url), "utf8");

test("dashboard exposes stable sections and review task metadata", () => {
  assert.match(appSource, /data-review-section="due"/);
  assert.match(appSource, /data-review-section="reviewed"/);
  assert.match(appSource, /data-review-section="future"/);
  for (const attribute of [
    "data-task-id",
    "data-source-type",
    "data-source-id",
    "data-title",
    "data-scheduled-date",
    "data-memory-score",
    "data-tag-paths",
    "data-detail",
    "data-codex-review-url",
  ]) {
    assert.match(appSource, new RegExp(attribute));
  }
});

test("review-day refresh handles timers, focus, and visibility recovery", () => {
  assert.match(appSource, /millisecondsUntilReviewDayBoundary/);
  assert.match(appSource, /window\.addEventListener\("focus"/);
  assert.match(appSource, /document\.addEventListener\("visibilitychange"/);
  assert.match(appSource, /window\.addEventListener\("pageshow"/);
  assert.match(appSource, /reviewDayRefreshInProgress/);
});

test("dashboard and V52 snapshot share the same authoritative due function", () => {
  assert.match(appSource, /function buildTodayDueTasks\(/);
  assert.match(appSource, /const due = buildTodayDueTasks\(tasks, today\);/);
  const snapshotStart = appSource.indexOf("function buildV52TodaySnapshotInput");
  const snapshotEnd = appSource.indexOf("function applyDailyCapacity", snapshotStart);
  assert.match(appSource.slice(snapshotStart, snapshotEnd), /tasks: buildTodayDueTasks\(\)\.map/);
});

test("V52 sync is a minimal push-only module with fixed recovery intervals", () => {
  assert.match(syncSource, /const HEARTBEAT_INTERVAL_MS = 5 \* 60 \* 1000;/);
  assert.match(syncSource, /const REFRESH_POLL_INTERVAL_MS = 30 \* 1000;/);
  assert.match(syncSource, /\/api\/review-manager\/bridge\/today-snapshot/);
  assert.match(syncSource, /\/api\/review-manager\/bridge\/today-refresh-request/);
  assert.doesNotMatch(syncSource, /indexedDB|psych312-memory-review-bridge-v1/);
  assert.doesNotMatch(syncSource, /completed|recallPercent|memoryScore|notes|logs/);
});

test("Codex link generator loads before the application entrypoint", () => {
  const linksIndex = indexSource.indexOf("codex-review-links.js");
  const appIndex = indexSource.indexOf("app.js?v=");
  assert.ok(linksIndex >= 0 && linksIndex < appIndex);
});

test("V52 sync module loads before the application entrypoint", () => {
  const syncIndex = indexSource.indexOf("v52-today-sync.js");
  const appIndex = indexSource.indexOf("app.js?v=");
  assert.ok(syncIndex >= 0 && syncIndex < appIndex);
});
