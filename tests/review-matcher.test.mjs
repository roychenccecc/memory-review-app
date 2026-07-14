import test from "node:test";
import assert from "node:assert/strict";

await import("../review-matcher.js");

const matcher = globalThis.ReviewMatcher;

test("review matcher normalizes psychology subject aliases", () => {
  assert.deepEqual(matcher.splitSubjectAndChapter("普通心理学 第二章 人的信息加工"), {
    subject: "普心",
    chapter: "人的信息加工",
  });
});

test("review matcher keeps the confirmed source ahead of fuzzy matches", () => {
  const rows = [
    { sourceId: "study-1", title: "普心 人的信息加工", tagPaths: [], taskId: "" },
    { sourceId: "study-2", title: "普心 感觉", tagPaths: [], taskId: "" },
  ];
  const ranked = matcher.rankCandidates("普通心理学 人的信息加工", rows, {
    preferredSourceId: "study-2",
  });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sourceId, "study-2");
  assert.equal(ranked[0].score, 100);
});
