import test from "node:test";
import assert from "node:assert/strict";

await import("../codex-review-links.js");

const links = globalThis.CodexReviewLinks;

test("study review links use a minimal Chinese prompt and the 312 workspace", () => {
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
  assert.equal(prompt, "带我复习：实验心理学 第二章");
  assert.doesNotMatch(prompt, /实验心理学 > 变量与设计/);
  assert.doesNotMatch(prompt, /study-1/);
  assert.doesNotMatch(prompt, /Chrome|AGENTS\.md|312-review-manager-handoff/);
});

test("study review links preserve spaces and punctuation in titles", () => {
  const url = links.buildCodexReviewUrl({
    sourceType: "study",
    sourceId: "study-punctuation",
    title: "心理统计：t 检验（独立样本）",
  });
  assert.equal(
    new URL(url).searchParams.get("prompt"),
    "带我复习：心理统计：t 检验（独立样本）"
  );
});

test("wrong-question tasks do not create Codex review links", () => {
  assert.equal(links.buildCodexReviewUrl({
    sourceType: "mistake",
    sourceId: "mistake-1",
    title: "错题",
  }), "");
});

test("daily links deduplicate study records and respect the four-item limit", () => {
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
  assert.equal(result.length, 4);
  assert.deepEqual(
    result.map((task) => task.sourceId),
    ["study-0", "study-1", "study-2", "study-3"]
  );
});
