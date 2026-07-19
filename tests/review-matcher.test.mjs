import test from "node:test";
import assert from "node:assert/strict";

await import("../canonical-subjects.js");
await import("../review-matcher.js");

const matcher = globalThis.ReviewMatcher;

test("review matcher normalizes psychology subject aliases", () => {
  assert.deepEqual(matcher.splitSubjectAndChapter("普通心理学 第二章 人的信息加工"), {
    subject: "普通心理学",
    chapter: "人的信息加工",
  });
  assert.deepEqual(matcher.splitSubjectAndChapter("发心 第二章 基本理论"), {
    subject: "发展心理学",
    chapter: "基本理论",
  });
  assert.deepEqual(matcher.splitSubjectAndChapter("心统 推断统计"), {
    subject: "心理统计学",
    chapter: "推断统计",
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

test("review matcher treats full-name targets and alias tag paths as the same subject", () => {
  const result = matcher.scoreCandidate("发展心理学 第二章 基本理论", {
    sourceId: "study-1",
    title: "发展 第二章 基本理论",
    tagPaths: ["发展 > 02-基本理论"],
    taskId: "",
  });
  assert.equal(result.score, 95);
  assert.match(result.reason, /科目一致/);
  assert.match(result.reason, /知识点路径一致/);
});
