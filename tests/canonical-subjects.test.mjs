import test from "node:test";
import assert from "node:assert/strict";

await import("../canonical-subjects.js");

const subjects = globalThis.CanonicalSubjects;

test("known psychology aliases normalize to canonical full subject names", () => {
  const expected = new Map([
    ["普心", "普通心理学"],
    ["发展", "发展心理学"],
    ["发心", "发展心理学"],
    ["实验", "实验心理学"],
    ["实心", "实验心理学"],
    ["统计", "心理统计学"],
    ["心统", "心理统计学"],
    ["心理统计", "心理统计学"],
    ["心理学统计", "心理统计学"],
    ["行为科学统计", "心理统计学"],
    ["心理学统计（行为科学统计）", "心理统计学"],
    ["心理学统计(行为科学统计)", "心理统计学"],
    ["教育", "教育心理学"],
    ["教心", "教育心理学"],
    ["测量", "心理测量学"],
    ["测心", "心理测量学"],
  ]);
  for (const [alias, canonical] of expected) {
    assert.equal(subjects.canonicalSubjectName(alias), canonical);
  }
  assert.equal(subjects.canonicalizeTagPath("发展 > 02-基本理论"), "发展心理学 > 02-基本理论");
  assert.equal(subjects.canonicalizeChapterTitle("普心 第二章 感觉"), "普通心理学 第二章 感觉");
  assert.equal(subjects.canonicalizeChapterTitle("发展性评价"), "发展性评价");
  assert.equal(subjects.canonicalSubjectName("未知简称"), "未知简称");
});

test("an alias-only subject root is renamed without changing its stable id", () => {
  const input = {
    tags: [
      { id: "root-development", name: "发展", parentId: "", importance: "high", createdAt: "2026-01-01" },
      { id: "chapter-two", name: "02-基本理论", parentId: "root-development", createdAt: "2026-01-02" },
    ],
    study: [{ id: "study-1", tagIds: ["root-development", "chapter-two"] }],
    mistakes: [],
    logs: [],
  };
  const migration = subjects.planTagRootMigration(input, { updatedAt: "2026-07-19" });
  assert.equal(migration.changed, true);
  assert.equal(migration.removedTagIds.length, 0);
  assert.deepEqual(migration.idRewrites, {});
  assert.equal(migration.tags.find((tag) => tag.id === "root-development").name, "发展心理学");
  assert.equal(migration.tags.find((tag) => tag.id === "chapter-two").parentId, "root-development");
  assert.deepEqual(migration.study[0].tagIds, ["root-development", "chapter-two"]);

  const second = subjects.planTagRootMigration(migration, { updatedAt: "2026-07-20" });
  assert.equal(second.changed, false);
});

test("canonical and alias trees merge recursively without losing metadata or references", () => {
  const input = {
    tags: [
      {
        id: "root-canonical",
        name: "发展心理学",
        parentId: "",
        importance: "medium",
        questionTypes: ["选择题"],
        reviewNotes: "全称根备注",
        color: "#111111",
        createdAt: "2026-02-01",
      },
      {
        id: "root-alias",
        name: "发展",
        parentId: "",
        importance: "high",
        questionTypes: ["简答题"],
        reviewNotes: "简称根备注",
        color: "#222222",
        createdAt: "2026-01-01",
      },
      {
        id: "chapter-canonical",
        name: "02-基本理论",
        parentId: "root-canonical",
        importance: "medium",
        reviewNotes: "全称章节备注",
        createdAt: "2026-02-02",
      },
      {
        id: "chapter-alias",
        name: "02-基本理论",
        parentId: "root-alias",
        importance: "veryHigh",
        reviewNotes: "简称章节备注",
        createdAt: "2026-01-02",
      },
      {
        id: "chapter-unique",
        name: "03-研究方法",
        parentId: "root-alias",
        importance: "medium",
        createdAt: "2026-01-03",
      },
    ],
    study: [{ id: "study-1", tagIds: ["chapter-canonical", "chapter-alias", "root-alias"] }],
    mistakes: [{ id: "mistake-1", tagIds: ["chapter-alias"] }],
    logs: [{
      id: "log-1",
      tagId: "chapter-alias",
      tagIds: ["chapter-canonical", "chapter-alias"],
      recallPercent: 73,
      sectionScores: [
        { tagId: "chapter-canonical", score: 70, weight: 2, source: "canonical" },
        { tagId: "chapter-alias", score: 90, weight: 5, note: "alias detail" },
      ],
    }],
  };

  const migration = subjects.planTagRootMigration(input, { updatedAt: "2026-07-19" });
  assert.equal(migration.changed, true);
  assert.deepEqual(new Set(migration.removedTagIds), new Set(["root-alias", "chapter-alias"]));
  assert.deepEqual(migration.idRewrites, {
    "root-alias": "root-canonical",
    "chapter-alias": "chapter-canonical",
  });

  const root = migration.tags.find((tag) => tag.id === "root-canonical");
  const chapter = migration.tags.find((tag) => tag.id === "chapter-canonical");
  const unique = migration.tags.find((tag) => tag.id === "chapter-unique");
  assert.equal(root.name, "发展心理学");
  assert.equal(root.importance, "high");
  assert.deepEqual(root.questionTypes, ["选择题", "简答题"]);
  assert.equal(root.reviewNotes, "全称根备注\n\n简称根备注");
  assert.equal(root.color, "#111111");
  assert.equal(chapter.importance, "veryHigh");
  assert.equal(chapter.reviewNotes, "全称章节备注\n\n简称章节备注");
  assert.equal(unique.parentId, "root-canonical");
  assert.deepEqual(migration.study[0].tagIds, ["chapter-canonical", "root-canonical"]);
  assert.deepEqual(migration.mistakes[0].tagIds, ["chapter-canonical"]);

  const log = migration.logs[0];
  assert.equal(log.tagId, "chapter-canonical");
  assert.deepEqual(log.tagIds, ["chapter-canonical"]);
  assert.equal(log.recallPercent, 73);
  assert.equal(log.sectionScores.length, 1);
  assert.equal(log.sectionScores[0].tagId, "chapter-canonical");
  assert.equal(log.sectionScores[0].weight, 7);
  assert.ok(Math.abs(log.sectionScores[0].score - (590 / 7)) < 1e-12);
  assert.equal(log.sectionScores[0].source, "canonical");
  assert.equal(log.sectionScores[0].note, "alias detail");

  const liveIds = new Set(migration.tags.map((tag) => tag.id));
  for (const tag of migration.tags) {
    if (tag.parentId) assert.ok(liveIds.has(tag.parentId));
  }
  for (const row of [...migration.study, ...migration.mistakes]) {
    for (const tagId of row.tagIds || []) assert.ok(liveIds.has(tagId));
  }
  for (const section of log.sectionScores) assert.ok(liveIds.has(section.tagId));

  const second = subjects.planTagRootMigration(migration, { updatedAt: "2026-07-20" });
  assert.equal(second.changed, false);
});

test("bridge paths and pending section score ids follow the same migration", () => {
  const bridge = {
    reviewDrafts: [{
      draftId: "draft-1",
      subject: "发展",
      title: "发展 第二章 基本理论",
      target: { title: "发展 第二章 基本理论", tagPath: "发展 > 02-基本理论" },
      sectionScores: [
        { tagId: "chapter-canonical", tagPath: "发展心理学 > 02-基本理论", score: 60, weight: 2 },
        { tagId: "chapter-alias", tagPath: "发展 > 02-基本理论", score: 90, weight: 3 },
      ],
    }],
    reviewBindings: {
      "发展 第二章 基本理论": {
        sourceId: "study-1",
        title: "发展 第二章 基本理论",
        tagPaths: ["发展 > 02-基本理论"],
      },
    },
  };
  const canonical = subjects.canonicalizeBridgeState(bridge, {
    idRewrites: { "chapter-alias": "chapter-canonical" },
  });
  const draft = canonical.reviewDrafts[0];
  assert.equal(draft.subject, "发展心理学");
  assert.equal(draft.title, "发展心理学 第二章 基本理论");
  assert.equal(draft.target.tagPath, "发展心理学 > 02-基本理论");
  assert.equal(draft.sectionScores.length, 1);
  assert.equal(draft.sectionScores[0].tagId, "chapter-canonical");
  assert.equal(draft.sectionScores[0].weight, 5);
  assert.equal(draft.sectionScores[0].score, 78);
  assert.deepEqual(Object.keys(canonical.reviewBindings), ["发展心理学 第二章 基本理论"]);
  assert.deepEqual(
    canonical.reviewBindings["发展心理学 第二章 基本理论"].tagPaths,
    ["发展心理学 > 02-基本理论"],
  );
});
