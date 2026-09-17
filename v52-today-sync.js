(function attachV52TodaySync(global) {
  "use strict";

  const CONTRACT_VERSION = "V52_REVIEW_MANAGER_TODAY_V1";
  const CONFIG_KEY = "memory-review-v52-today-sync-config-v1";
  const DEFAULT_ENDPOINT_BASE = "http://127.0.0.1:8765";
  const SOURCE = Object.freeze({
    manager_id: "adaptive-memory-review",
    app: "memory-review-app",
    origin: "https://roychenccecc.github.io",
    page_path: "/memory-review-app/",
  });
  const REVIEW_DAY_BOUNDARY_HOUR = 3;
  const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
  const REFRESH_POLL_INTERVAL_MS = 30 * 1000;
  const PUSH_DEBOUNCE_MS = 250;
  const REQUEST_TIMEOUT_MS = 10 * 1000;
  const MAX_REQUEST_BYTES = 128 * 1024;
  const MAX_TASKS = 80;
  const TASK_FIELDS = Object.freeze([
    "task_id",
    "source_id",
    "source_type",
    "title",
    "scheduled_date",
    "source",
    "status",
  ]);
  const TASK_LIMITS = Object.freeze({
    task_id: 160,
    source_id: 160,
    source_type: 40,
    title: 240,
    scheduled_date: 10,
    source: 40,
    status: 40,
  });

  let getSnapshotInput = null;
  let statusListener = null;
  let initialized = false;
  let heartbeatTimer = 0;
  let refreshPollTimer = 0;
  let pushTimer = 0;
  let pushInFlight = null;
  let queuedPush = null;
  let lastObservedRefreshRequestId = 0;
  let lastAcknowledgedRefreshRequestId = 0;
  let lastSubmittedRevision = "";
  let status = Object.freeze({
    state: "DISABLED",
    message: "尚未启用 V52 同步。",
    lastSuccessAt: "",
    lastRevision: "",
    lastTaskCount: null,
    lastError: "",
    pendingRefreshRequestId: 0,
  });

  function plainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function assertExactKeys(value, expected, label) {
    if (!plainObject(value)) throw new Error(`${label} 必须是对象。`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
      throw new Error(`${label} 字段不符合合同。`);
    }
  }

  function hasLoneSurrogate(value) {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

  function contractText(value, field, maximum) {
    if (typeof value !== "string" || !value || value.length > maximum) {
      throw new Error(`${field} 不是有效字符串。`);
    }
    if (/[\u0000-\u001f\u007f]/u.test(value) || hasLoneSurrogate(value)) {
      throw new Error(`${field} 含有无效字符。`);
    }
    return value;
  }

  function contractDate(value, field) {
    const text = contractText(value, field, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) throw new Error(`${field} 日期格式无效。`);
    const parsed = new Date(`${text}T12:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
      throw new Error(`${field} 日期无效。`);
    }
    return text;
  }

  function contractTimeZone(value) {
    const timeZone = contractText(value, "snapshot.time_zone", 80);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    } catch {
      throw new Error("snapshot.time_zone 不是有效 IANA 时区。");
    }
    return timeZone;
  }

  function contractTimestamp(value) {
    const timestamp = contractText(value, "snapshot.generated_at", 80);
    if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
      throw new Error("snapshot.generated_at 必须包含时区。 ");
    }
    return timestamp;
  }

  function normalizeTask(task, index) {
    assertExactKeys(task, TASK_FIELDS, `tasks[${index}]`);
    const value = {};
    for (const field of TASK_FIELDS) {
      value[field] = contractText(task[field], `tasks[${index}].${field}`, TASK_LIMITS[field]);
    }
    if (!new Set(["study", "mistake"]).has(value.source_type)) {
      throw new Error(`tasks[${index}].source_type 不受支持。`);
    }
    if (value.source !== SOURCE.app || value.status !== "pending") {
      throw new Error(`tasks[${index}] 来源或状态不符合合同。`);
    }
    value.scheduled_date = contractDate(value.scheduled_date, `tasks[${index}].scheduled_date`);
    return value;
  }

  function normalizeRevisionInput(input) {
    assertExactKeys(
      input,
      ["review_day", "time_zone", "review_day_boundary_hour", "tasks"],
      "revision input"
    );
    if (input.review_day_boundary_hour !== REVIEW_DAY_BOUNDARY_HOUR) {
      throw new Error("review_day_boundary_hour 必须为 3。");
    }
    if (!Array.isArray(input.tasks) || input.tasks.length > MAX_TASKS) {
      throw new Error("tasks 数量不符合合同。");
    }
    const tasks = input.tasks.map(normalizeTask);
    const taskIds = new Set();
    const sourceIds = new Set();
    for (const task of tasks) {
      const sourceKey = `${task.source_type}:${task.source_id}`;
      if (taskIds.has(task.task_id) || sourceIds.has(sourceKey)) {
        throw new Error("tasks 含有重复任务身份。");
      }
      taskIds.add(task.task_id);
      sourceIds.add(sourceKey);
    }
    return {
      review_day: contractDate(input.review_day, "snapshot.review_day"),
      time_zone: contractTimeZone(input.time_zone),
      review_day_boundary_hour: REVIEW_DAY_BOUNDARY_HOUR,
      tasks,
    };
  }

  function canonicalRevisionJson(input) {
    return JSON.stringify(normalizeRevisionInput(input));
  }

  async function sha256Revision(input) {
    if (!global.crypto?.subtle) throw new Error("当前浏览器不支持 SHA-256。");
    const bytes = new TextEncoder().encode(canonicalRevisionJson(input));
    const digest = await global.crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return `sha256:${hex}`;
  }

  function normalizeRefreshRequestId(value) {
    const requestId = value == null ? 0 : Number(value);
    if (!Number.isSafeInteger(requestId) || requestId < 0) {
      throw new Error("refresh_request_id 必须是非负整数。");
    }
    return requestId;
  }

  async function buildSnapshotRequest(input, options = {}) {
    assertExactKeys(input, ["reviewDay", "timeZone", "tasks"], "snapshot source");
    const revisionInput = normalizeRevisionInput({
      review_day: input.reviewDay,
      time_zone: input.timeZone,
      review_day_boundary_hour: REVIEW_DAY_BOUNDARY_HOUR,
      tasks: input.tasks,
    });
    const revision = await sha256Revision(revisionInput);
    const generatedAt = contractTimestamp(options.generatedAt || new Date().toISOString());
    const refreshRequestId = normalizeRefreshRequestId(options.refreshRequestId);
    const payload = {
      contract_version: CONTRACT_VERSION,
      source: { ...SOURCE },
      snapshot: {
        revision,
        generated_at: generatedAt,
        review_day: revisionInput.review_day,
        time_zone: revisionInput.time_zone,
        review_day_boundary_hour: REVIEW_DAY_BOUNDARY_HOUR,
        complete: true,
        refresh_request_id: refreshRequestId,
      },
      tasks: revisionInput.tasks,
    };
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_REQUEST_BYTES) {
      throw new Error("今日快照超过大小限制。");
    }
    return payload;
  }

  function normalizeEndpointBase(value) {
    let url;
    try {
      url = new URL(String(value || DEFAULT_ENDPOINT_BASE));
    } catch {
      throw new Error("V52 地址无效。");
    }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
      throw new Error("V52 地址必须使用 http://127.0.0.1:端口。");
    }
    const port = Number(url.port || 80);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("V52 端口无效。");
    if (!new Set(["", "/"]).has(url.pathname) || url.search || url.hash) {
      throw new Error("V52 地址不能包含路径、查询参数或片段。");
    }
    return `${url.protocol}//${url.hostname}:${port}`;
  }

  function defaultConfig() {
    return { enabled: false, endpointBase: DEFAULT_ENDPOINT_BASE };
  }

  function readConfig() {
    try {
      const parsed = JSON.parse(global.localStorage?.getItem(CONFIG_KEY) || "null");
      if (!plainObject(parsed)) return defaultConfig();
      return {
        enabled: parsed.enabled === true,
        endpointBase: normalizeEndpointBase(parsed.endpointBase),
      };
    } catch {
      return defaultConfig();
    }
  }

  function saveConfig(value) {
    const previous = readConfig();
    const config = {
      enabled: value?.enabled === true,
      endpointBase: normalizeEndpointBase(value?.endpointBase),
    };
    global.localStorage?.setItem(CONFIG_KEY, JSON.stringify(config));
    if (previous.endpointBase !== config.endpointBase || previous.enabled !== config.enabled) {
      lastObservedRefreshRequestId = 0;
      lastAcknowledgedRefreshRequestId = 0;
      lastSubmittedRevision = "";
    }
    if (!config.enabled) {
      queuedPush = null;
      updateStatus({
        state: "DISABLED",
        message: "尚未启用 V52 同步。",
        lastError: "",
        pendingRefreshRequestId: 0,
      });
    } else {
      updateStatus({ state: "WAITING", message: "等待发送今日快照。", lastError: "" });
      schedulePush("settings", { force: true });
    }
    return config;
  }

  function getConfig() {
    return readConfig();
  }

  function updateStatus(changes) {
    status = Object.freeze({ ...status, ...changes });
    statusListener?.(status);
  }

  function getStatus() {
    return status;
  }

  function sourceOriginIsAllowed() {
    return global.location?.origin === SOURCE.origin;
  }

  function endpoint(config, path) {
    return `${config.endpointBase}${path}`;
  }

  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = global.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await global.fetch(url, {
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        ...options,
        signal: controller.signal,
      });
    } finally {
      global.clearTimeout(timer);
    }
  }

  async function responseJson(response) {
    let value = null;
    try {
      value = await response.json();
    } catch {
      throw new Error(`V52 返回了无法解析的响应（HTTP ${response.status}）。`);
    }
    if (!response.ok) {
      const message = value?.error?.message || value?.message || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return value;
  }

  async function executePush(reason, options = {}) {
    const config = readConfig();
    if (!config.enabled) return null;
    if (!sourceOriginIsAllowed()) {
      updateStatus({
        state: "LOCAL_PREVIEW",
        message: "本地预览不会向 V52 发送数据。",
        lastError: "",
      });
      return null;
    }
    if (typeof getSnapshotInput !== "function") throw new Error("今日快照数据入口未就绪。");
    updateStatus({ state: "SYNCING", message: "正在发送今日快照。", lastError: "" });
    const refreshRequestId = Math.max(
      normalizeRefreshRequestId(options.refreshRequestId),
      lastObservedRefreshRequestId
    );
    const payload = await buildSnapshotRequest(getSnapshotInput(), { refreshRequestId });
    if (!options.force && status.state === "READY" && payload.snapshot.revision === lastSubmittedRevision) {
      updateStatus({
        state: "READY",
        message: payload.tasks.length ? `今日 ${payload.tasks.length} 项待办没有变化。` : "今日空列表没有变化。",
        lastTaskCount: payload.tasks.length,
        lastError: "",
      });
      return { status: "unchanged", contract_version: CONTRACT_VERSION };
    }
    const response = await fetchWithTimeout(
      endpoint(config, "/api/review-manager/bridge/today-snapshot"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    const result = await responseJson(response);
    if (result?.contract_version !== CONTRACT_VERSION || result?.status !== "accepted") {
      throw new Error("V52 未确认接收今日快照。");
    }
    lastSubmittedRevision = payload.snapshot.revision;
    lastAcknowledgedRefreshRequestId = Math.max(lastAcknowledgedRefreshRequestId, refreshRequestId);
    updateStatus({
      state: "READY",
      message: payload.tasks.length ? `已同步 ${payload.tasks.length} 项今日待办。` : "已确认今天没有待复习任务。",
      lastSuccessAt: new Date().toISOString(),
      lastRevision: payload.snapshot.revision,
      lastTaskCount: payload.tasks.length,
      lastError: "",
      pendingRefreshRequestId: Math.max(0, lastObservedRefreshRequestId - lastAcknowledgedRefreshRequestId),
      lastReason: reason,
    });
    return result;
  }

  function queueFollowUp(reason, options) {
    queuedPush = {
      reason,
      options: {
        force: Boolean(options?.force || queuedPush?.options?.force),
        refreshRequestId: Math.max(
          normalizeRefreshRequestId(options?.refreshRequestId),
          normalizeRefreshRequestId(queuedPush?.options?.refreshRequestId)
        ),
      },
    };
  }

  async function pushNow(reason = "manual", options = {}) {
    if (pushInFlight) {
      queueFollowUp(reason, options);
      return pushInFlight;
    }
    pushInFlight = executePush(reason, options)
      .catch((error) => {
        updateStatus({
          state: "ERROR",
          message: "同步失败，V52 应继续保留上次成功快照。",
          lastError: error?.message || "未知连接错误",
          pendingRefreshRequestId: Math.max(0, lastObservedRefreshRequestId - lastAcknowledgedRefreshRequestId),
        });
        return null;
      })
      .finally(() => {
        pushInFlight = null;
        if (queuedPush) {
          const next = queuedPush;
          queuedPush = null;
          pushNow(next.reason, next.options);
        }
      });
    return pushInFlight;
  }

  function schedulePush(reason = "change", options = {}) {
    const config = readConfig();
    if (!config.enabled) return;
    global.clearTimeout(pushTimer);
    pushTimer = global.setTimeout(() => pushNow(reason, options), PUSH_DEBOUNCE_MS);
  }

  async function pollRefreshRequest() {
    const config = readConfig();
    if (!config.enabled || !sourceOriginIsAllowed() || global.document?.visibilityState === "hidden") return;
    try {
      const response = await fetchWithTimeout(
        endpoint(config, "/api/review-manager/bridge/today-refresh-request"),
        { method: "GET" }
      );
      const value = await responseJson(response);
      if (value?.contract_version !== CONTRACT_VERSION) throw new Error("V52 刷新请求合同不匹配。");
      const requestId = normalizeRefreshRequestId(value.refresh_request_id);
      lastObservedRefreshRequestId = Math.max(lastObservedRefreshRequestId, requestId);
      if (lastObservedRefreshRequestId > lastAcknowledgedRefreshRequestId) {
        updateStatus({ pendingRefreshRequestId: lastObservedRefreshRequestId - lastAcknowledgedRefreshRequestId });
        schedulePush("refresh-request", {
          force: true,
          refreshRequestId: lastObservedRefreshRequestId,
        });
      }
    } catch (error) {
      updateStatus({
        state: "ERROR",
        message: "无法读取 V52 的刷新请求，已保留本页数据。",
        lastError: error?.message || "未知连接错误",
      });
    }
  }

  function handleVisibleRecovery(reason) {
    if (global.document?.visibilityState === "hidden") return;
    pollRefreshRequest();
    schedulePush(reason, { force: true });
  }

  function startTimers() {
    global.clearInterval(heartbeatTimer);
    global.clearInterval(refreshPollTimer);
    heartbeatTimer = global.setInterval(() => {
      if (global.document?.visibilityState !== "hidden") pushNow("heartbeat", { force: true });
    }, HEARTBEAT_INTERVAL_MS);
    refreshPollTimer = global.setInterval(() => pollRefreshRequest(), REFRESH_POLL_INTERVAL_MS);
  }

  function initialize(options = {}) {
    getSnapshotInput = options.getSnapshotInput;
    statusListener = options.onStatusChange || null;
    if (!initialized) {
      initialized = true;
      global.addEventListener?.("focus", () => handleVisibleRecovery("focus"));
      global.addEventListener?.("pageshow", () => handleVisibleRecovery("pageshow"));
      global.document?.addEventListener("visibilitychange", () => {
        if (global.document.visibilityState === "visible") handleVisibleRecovery("visibility");
      });
      startTimers();
    }
    const config = readConfig();
    updateStatus(config.enabled
      ? { state: "WAITING", message: "等待发送今日快照。", lastError: "" }
      : { state: "DISABLED", message: "尚未启用 V52 同步。", lastError: "" });
    if (config.enabled) {
      pollRefreshRequest().finally(() => schedulePush("initial", { force: true }));
    }
    return { config, status };
  }

  global.V52TodaySync = Object.freeze({
    CONFIG_KEY,
    CONTRACT_VERSION,
    DEFAULT_ENDPOINT_BASE,
    HEARTBEAT_INTERVAL_MS,
    MAX_REQUEST_BYTES,
    REFRESH_POLL_INTERVAL_MS,
    REVIEW_DAY_BOUNDARY_HOUR,
    SOURCE,
    TASK_FIELDS,
    buildSnapshotRequest,
    canonicalRevisionJson,
    getConfig,
    getStatus,
    initialize,
    normalizeEndpointBase,
    normalizeRevisionInput,
    pollRefreshRequest,
    pushNow,
    saveConfig,
    schedulePush,
    sha256Revision,
  });
})(globalThis);
