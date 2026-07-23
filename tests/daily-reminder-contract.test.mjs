import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
const indexSource = await readFile(new URL("../index.html", import.meta.url), "utf8");

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
  assert.match(appSource, /reviewDayRefreshInProgress/);
});

test("Codex link generator loads before the application entrypoint", () => {
  const linksIndex = indexSource.indexOf("codex-review-links.js");
  const appIndex = indexSource.indexOf("app.js?v=");
  assert.ok(linksIndex >= 0 && linksIndex < appIndex);
});
