import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
await import("../v52-today-sync.js");

const sync = globalThis.V52TodaySync;
const vector = JSON.parse(await readFile(
  new URL("./fixtures/v52-today-sync-v1.json", import.meta.url),
  "utf8"
));

function studyTask(overrides = {}) {
  return {
    task_id: "task-study-001",
    source_id: "study-001",
    source_type: "study",
    title: "心理学统计：导论与频数分布",
    scheduled_date: "2026-09-12",
    source: "memory-review-app",
    status: "pending",
    ...overrides,
  };
}

test("non-ASCII canonical vector has the fixed cross-language SHA-256", async () => {
  const canonical = sync.canonicalRevisionJson(vector.revision_input);
  assert.equal(canonical, vector.canonical_json);
  assert.equal(Buffer.byteLength(canonical, "utf8"), vector.utf8_byte_length);
  assert.equal(
    `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`,
    vector.expected_revision
  );
  assert.equal(await sync.sha256Revision(vector.revision_input), vector.expected_revision);
});

test("snapshot exposes only the agreed read-only fields", async () => {
  const payload = await sync.buildSnapshotRequest({
    reviewDay: "2026-09-12",
    timeZone: "Asia/Shanghai",
    tasks: [studyTask()],
  }, {
    generatedAt: "2026-09-12T03:05:00.000+08:00",
    refreshRequestId: 7,
  });
  assert.deepEqual(Object.keys(payload), ["contract_version", "source", "snapshot", "tasks"]);
  assert.deepEqual(Object.keys(payload.tasks[0]), sync.TASK_FIELDS);
  assert.equal(payload.snapshot.complete, true);
  assert.equal(payload.snapshot.refresh_request_id, 7);
  assert.equal(payload.snapshot.revision.length, 71);
  assert.doesNotMatch(JSON.stringify(payload), /memoryScore|notes|tag|question|recall|log/i);
});

test("valid complete empty snapshot remains distinguishable from failure", async () => {
  const payload = await sync.buildSnapshotRequest({
    reviewDay: "2026-09-12",
    timeZone: "Asia/Shanghai",
    tasks: [],
  }, { generatedAt: "2026-09-12T03:05:00.000Z" });
  assert.equal(payload.snapshot.complete, true);
  assert.deepEqual(payload.tasks, []);
  assert.match(payload.snapshot.revision, /^sha256:[0-9a-f]{64}$/);
});

test("task order changes revision and remains in display order", async () => {
  const first = studyTask();
  const second = studyTask({ task_id: "task-002", source_id: "study-002", title: "实验设计" });
  const common = { reviewDay: "2026-09-12", timeZone: "Asia/Shanghai" };
  const forward = await sync.buildSnapshotRequest({ ...common, tasks: [first, second] });
  const reverse = await sync.buildSnapshotRequest({ ...common, tasks: [second, first] });
  assert.notEqual(forward.snapshot.revision, reverse.snapshot.revision);
  assert.deepEqual(forward.tasks.map((task) => task.task_id), ["task-study-001", "task-002"]);
});

test("duplicate task or stable source identity is rejected", async () => {
  const common = { reviewDay: "2026-09-12", timeZone: "Asia/Shanghai" };
  await assert.rejects(
    sync.buildSnapshotRequest({ ...common, tasks: [studyTask(), studyTask()] }),
    /重复任务身份/
  );
  await assert.rejects(
    sync.buildSnapshotRequest({
      ...common,
      tasks: [studyTask(), studyTask({ task_id: "task-other" })],
    }),
    /重复任务身份/
  );
});

test("unknown fields, controls, lone surrogates, and invalid dates are rejected", async () => {
  const common = { reviewDay: "2026-09-12", timeZone: "Asia/Shanghai" };
  await assert.rejects(
    sync.buildSnapshotRequest({ ...common, tasks: [studyTask({ notes: "private" })] }),
    /字段不符合合同/
  );
  await assert.rejects(
    sync.buildSnapshotRequest({ ...common, tasks: [studyTask({ title: "标题\n第二行" })] }),
    /无效字符/
  );
  await assert.rejects(
    sync.buildSnapshotRequest({ ...common, tasks: [studyTask({ title: "坏字符\ud800" })] }),
    /无效字符/
  );
  await assert.rejects(
    sync.buildSnapshotRequest({ ...common, tasks: [studyTask({ scheduled_date: "2026-02-30" })] }),
    /日期无效/
  );
});

test("only explicit 127.0.0.1 HTTP endpoints are accepted", () => {
  assert.equal(sync.normalizeEndpointBase("http://127.0.0.1:8765"), "http://127.0.0.1:8765");
  assert.throws(() => sync.normalizeEndpointBase("http://localhost:8765"), /必须使用/);
  assert.throws(() => sync.normalizeEndpointBase("https://127.0.0.1:8765"), /必须使用/);
  assert.throws(() => sync.normalizeEndpointBase("http://127.0.0.1:8765/private"), /不能包含路径/);
});
