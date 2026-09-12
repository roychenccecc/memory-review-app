import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../v52-today-sync.js", import.meta.url), "utf8");

function testTask() {
  return {
    task_id: "task-学习-001",
    source_id: "study-001",
    source_type: "study",
    title: "心理学统计：导论",
    scheduled_date: "2026-09-12",
    source: "memory-review-app",
    status: "pending",
  };
}

function createRuntime(origin = "https://roychenccecc.github.io") {
  const values = new Map();
  const debounceCallbacks = [];
  const requests = [];
  let fetchHandler = async (url, options) => ({
    ok: true,
    status: 200,
    json: async () => url.endsWith("today-refresh-request")
      ? { contract_version: "V52_REVIEW_MANAGER_TODAY_V1", refresh_request_id: 0 }
      : { contract_version: "V52_REVIEW_MANAGER_TODAY_V1", status: "accepted" },
  });
  const context = {
    AbortController,
    Date,
    Intl,
    TextEncoder,
    URL,
    crypto: webcrypto,
    document: { visibilityState: "visible", addEventListener() {} },
    location: { origin },
    localStorage: {
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) { values.set(key, value); },
    },
    addEventListener() {},
    clearInterval() {},
    clearTimeout() {},
    setInterval() { return 1; },
    setTimeout(callback, delay) {
      if (delay === 250) debounceCallbacks.push(callback);
      return 1;
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return fetchHandler(url, options);
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "v52-today-sync.js" });
  return {
    requests,
    sync: context.V52TodaySync,
    setFetchHandler(handler) { fetchHandler = handler; },
    async runDebounce() {
      const callback = debounceCallbacks.shift();
      if (callback) await callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function initialize(runtime) {
  runtime.sync.initialize({
    getSnapshotInput: () => ({
      reviewDay: "2026-09-12",
      timeZone: "Asia/Shanghai",
      tasks: [testTask()],
    }),
  });
}

test("sync remains opt-in and sends one minimal POST after enabling", async () => {
  const runtime = createRuntime();
  initialize(runtime);
  assert.equal(runtime.requests.length, 0);
  runtime.sync.saveConfig({ enabled: true, endpointBase: "http://127.0.0.1:8765" });
  await runtime.sync.pushNow("manual", { force: true });
  assert.equal(runtime.requests.length, 1);
  assert.equal(runtime.requests[0].url, "http://127.0.0.1:8765/api/review-manager/bridge/today-snapshot");
  assert.equal(runtime.requests[0].options.method, "POST");
  assert.equal(runtime.requests[0].options.credentials, "omit");
  const payload = JSON.parse(runtime.requests[0].options.body);
  assert.deepEqual(Object.keys(payload.tasks[0]), [...runtime.sync.TASK_FIELDS]);
  assert.equal(runtime.sync.getStatus().state, "READY");
});

test("a failed push keeps last successful metadata and reports an error", async () => {
  const runtime = createRuntime();
  initialize(runtime);
  runtime.sync.saveConfig({ enabled: true, endpointBase: "http://127.0.0.1:8765" });
  await runtime.sync.pushNow("manual", { force: true });
  const success = runtime.sync.getStatus();
  runtime.setFetchHandler(async () => { throw new TypeError("connection refused"); });
  await runtime.sync.pushNow("heartbeat", { force: true });
  const failure = runtime.sync.getStatus();
  assert.equal(failure.state, "ERROR");
  assert.equal(failure.lastSuccessAt, success.lastSuccessAt);
  assert.equal(failure.lastRevision, success.lastRevision);
  assert.equal(failure.lastTaskCount, 1);
  assert.match(failure.lastError, /connection refused/);
  runtime.setFetchHandler(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ contract_version: "V52_REVIEW_MANAGER_TODAY_V1", status: "accepted" }),
  }));
  await runtime.sync.pushNow("render");
  assert.equal(runtime.requests.length, 3);
  assert.equal(runtime.sync.getStatus().state, "READY");
});

test("a refresh request is acknowledged only by a following snapshot", async () => {
  const runtime = createRuntime();
  initialize(runtime);
  runtime.sync.saveConfig({ enabled: true, endpointBase: "http://127.0.0.1:8765" });
  await runtime.sync.pushNow("initial", { force: true });
  runtime.setFetchHandler(async (url) => ({
    ok: true,
    status: 200,
    json: async () => url.endsWith("today-refresh-request")
      ? { contract_version: "V52_REVIEW_MANAGER_TODAY_V1", refresh_request_id: 9 }
      : { contract_version: "V52_REVIEW_MANAGER_TODAY_V1", status: "accepted" },
  }));
  await runtime.sync.pollRefreshRequest();
  assert.equal(runtime.sync.getStatus().pendingRefreshRequestId, 9);
  await runtime.runDebounce();
  const posts = runtime.requests.filter((request) => request.url.endsWith("today-snapshot"));
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[1].options.body).snapshot.refresh_request_id, 9);
  assert.equal(runtime.sync.getStatus().pendingRefreshRequestId, 0);
});

test("local preview origin never sends browser data", async () => {
  const runtime = createRuntime("http://127.0.0.1:4173");
  initialize(runtime);
  runtime.sync.saveConfig({ enabled: true, endpointBase: "http://127.0.0.1:8765" });
  await runtime.sync.pushNow("manual", { force: true });
  assert.equal(runtime.requests.length, 0);
  assert.equal(runtime.sync.getStatus().state, "LOCAL_PREVIEW");
});
