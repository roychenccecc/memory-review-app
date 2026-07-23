import test from "node:test";
import assert from "node:assert/strict";

await import("../codex-review-links.js");

const links = globalThis.CodexReviewLinks;

test("study review links preserve Chinese task context and use the 312 workspace", () => {
  const url = links.buildCodexReviewUrl({
    taskId: "task-中文",
    sourceType: "study",
    sourceId: "study-1",
    title: "实验心理学 第二章",
    scheduledDate: "2026-07-23",
    memoryScore: 76,
    tagPaths: ["实验心理学 > 变量与设计"],
    detail: "重点复习自变量与因变量",
  });
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "codex:");
  assert.equal(
    parsed.searchParams.get("path"),
    "/Users/newlife/Documents/Codex/2026-06-11/new-chat/work/312-review-assistant"
  );
  const prompt = parsed.searchParams.get("prompt");
  assert.match(prompt, /实验心理学 第二章/);
  assert.match(prompt, /实验心理学 > 变量与设计/);
  assert.match(prompt, /study-1/);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /312-review-manager-handoff/);
});

test("wrong-question tasks do not create Codex review links", () => {
  assert.equal(links.buildCodexReviewUrl({
    sourceType: "mistake",
    sourceId: "mistake-1",
    title: "错题",
  }), "");
});

test("daily links deduplicate study records and respect the six-item limit", () => {
  const tasks = [
    { sourceType: "study", sourceId: "study-0", title: "重复项" },
    { sourceType: "study", sourceId: "study-0", title: "重复项" },
    { sourceType: "mistake", sourceId: "mistake-1", title: "忽略的错题" },
    ...Array.from({ length: 8 }, (_, index) => ({
      sourceType: "study",
      sourceId: `study-${index + 1}`,
      title: `学习 ${index + 1}`,
    })),
  ];
  const result = links.buildDailyReviewLinks(tasks);
  assert.equal(result.length, 6);
  assert.deepEqual(
    result.map((task) => task.sourceId),
    ["study-0", "study-1", "study-2", "study-3", "study-4", "study-5"]
  );
});
