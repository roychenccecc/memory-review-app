(function attachCodexHandoffV2(global) {
  "use strict";

  const BRIDGE_KEY = "psych312-memory-review-bridge-v1";
  const HASH_PARAM = "codexReviewDraft";
  const SOURCE = "codex-312-review-assistant";
  const DB_NAME = "adaptive-memory-review";
  const STORES = ["settings", "tags", "study", "mistakes", "logs", "tasks"];
  const BANNER_ID = "codexHandoffV2Recovery";
  const BASE_INTERVALS = Object.freeze([1, 2, 4, 7, 15, 30]);

  const now = () => new Date().toISOString();

  function readBridge() {
    try {
      const value = JSON.parse(global.localStorage.getItem(BRIDGE_KEY) || "{}") || {};
      return {
        ...value,
        reviewDrafts: Array.isArray(value.reviewDrafts) ? value.reviewDrafts : [],
        reviewBindings: value.reviewBindings && typeof value.reviewBindings === "object" ? value.reviewBindings : {},
      };
    } catch {
      return { version: 2, reviewDrafts: [], reviewBindings: {} };
    }
  }

  function writeBridge(bridge) {
    global.localStorage.setItem(BRIDGE_KEY, JSON.stringify({
      ...bridge,
      version: Math.max(2, Number(bridge.version) || 1),
      updatedAt: now(),
    }));
  }

  function decodeDraft(encoded) {
    const normalized = String(encoded || "").replaceAll("-", "+").replaceAll("_", "/");
    try {
      const binary = global.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
    } catch {
      try { return JSON.parse(decodeURIComponent(encoded)); } catch { return null; }
    }
  }

  function normalizeDraft(raw) {
    if (!raw || typeof raw !== "object") return null;
    const target = raw.target && typeof raw.target === "object" ? raw.target : {};
    const draftId = String(raw.draftId || "").trim();
    const title = String(target.title || raw.title || `${raw.subject || ""} ${raw.chapter || ""}`).trim();
    const score = Number(raw.overallScore ?? raw.recallPercent ?? raw.score);
    if (!draftId || !title || !Number.isFinite(score)) return null;
    return {
      ...raw,
      version: Math.max(3, Number(raw.version) || 1),
      source: SOURCE,
      scoreAuthority: raw.scoreAuthority === "sqlite" ? "sqlite" : "legacy-codex-draft",
      scoreReadOnly: true,
      draftId,
      sessionId: String(raw.sessionId || "").trim(),
      title,
      target: { ...target, sourceType: "study", title },
      overallScore: Math.max(0, Math.min(100, score)),
      notes: String(raw.notes || "").trim(),
    };
  }

  function captureFromHash() {
    const rawHash = String(global.location?.hash || "").replace(/^#/, "");
    if (!rawHash) return null;
    const params = new URLSearchParams(rawHash);
    const draft = normalizeDraft(decodeDraft(params.get(HASH_PARAM)));
    if (!draft) return null;
    const bridge = readBridge();
    const existing = bridge.reviewDrafts.find((item) => item.draftId === draft.draftId);
    bridge.reviewDrafts = existing
      ? bridge.reviewDrafts.map((item) => item.draftId === draft.draftId ? {
        ...item,
        ...draft,
        status: item.status || "pending",
        ...(item.status === "confirmed" ? { receiptDownloadStatus: "retry_requested" } : {}),
        updatedAt: now(),
      } : item)
      : [{ ...draft, status: "pending", capturedAt: now(), createdAt: now(), updatedAt: now() }, ...bridge.reviewDrafts];
    writeBridge(bridge);
    params.delete(HASH_PARAM);
    const remaining = params.toString();
    global.history.replaceState(
      null,
      global.document?.title || "",
      `${global.location.pathname}${global.location.search}${remaining ? `#${remaining}` : ""}`,
    );
    return draft;
  }

  function patchDraft(draftId, patch) {
    const bridge = readBridge();
    bridge.reviewDrafts = bridge.reviewDrafts.map((draft) => (
      draft.draftId === draftId ? { ...draft, ...patch, updatedAt: now() } : draft
    ));
    writeBridge(bridge);
    renderRecovery();
  }

  function dateValue(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
  }

  function daysBetween(earlier, later) {
    const start = dateValue(earlier);
    const end = dateValue(later);
    return start == null || end == null ? null : Math.max(0, Math.round((end - start) / 86400000));
  }

  function tierIndexAtOrBelow(days) {
    const value = Number(days);
    if (!Number.isFinite(value) || value < 1) return -1;
    let index = 0;
    for (let cursor = 0; cursor < BASE_INTERVALS.length; cursor += 1) {
      if (BASE_INTERVALS[cursor] > value) break;
      index = cursor;
    }
    return index;
  }

  function derivedIntervalMetrics(draft, saved, study, state) {
    const existing = { ...(draft.diagnosticMetrics || {}), ...(saved.diagnosticMetrics || {}) };
    const priorLogs = (state.logs || [])
      .filter((log) => log.id !== saved.id && log.sourceType === "study" && log.sourceId === study.id)
      .sort((left, right) => String(right.date || right.createdAt || "").localeCompare(String(left.date || left.createdAt || "")));
    const referenceDate = priorLogs[0]?.date || study.date || String(study.createdAt || "").slice(0, 10);
    const actualIntervalDays = daysBetween(referenceDate, saved.date || draft.date);
    const priorIndex = Number.isFinite(Number(saved.beforeIntervalIndex))
      ? Math.max(0, Math.min(BASE_INTERVALS.length - 1, Number(saved.beforeIntervalIndex)))
      : Math.max(0, tierIndexAtOrBelow(saved.beforeInterval || study.currentInterval || 1));
    const previousStabilityDays = Number(
      existing.previousStabilityDays ?? study.currentStabilityDays ?? study.stabilityDays ?? 0,
    );
    const previousStabilityIndex = tierIndexAtOrBelow(previousStabilityDays);
    const score = Math.max(0, Math.min(100, Number(saved.recallPercent ?? draft.overallScore) || 0));
    let nextIndex = priorIndex;
    let stabilityDays = previousStabilityDays;
    if (score >= 70) {
      const evidencedIndex = actualIntervalDays == null ? -1 : tierIndexAtOrBelow(actualIntervalDays);
      stabilityDays = evidencedIndex >= 0 ? BASE_INTERVALS[evidencedIndex] : BASE_INTERVALS[priorIndex];
      nextIndex = evidencedIndex >= 0
        ? Math.min(evidencedIndex + 1, BASE_INTERVALS.length - 1)
        : Math.min(priorIndex + 1, BASE_INTERVALS.length - 1);
    } else if (score >= 50) {
      nextIndex = Number(saved.beforeScore) < 60 ? Math.max(0, priorIndex - 1) : priorIndex;
      stabilityDays = previousStabilityIndex >= 0
        ? Math.min(previousStabilityDays, BASE_INTERVALS[nextIndex]) : 0;
    } else if (score >= 30) {
      nextIndex = Math.max(0, priorIndex - 2);
      stabilityDays = previousStabilityIndex >= 0
        ? Math.min(previousStabilityDays, BASE_INTERVALS[nextIndex]) : 0;
    } else {
      nextIndex = 0;
      stabilityDays = 0;
    }
    return {
      scoringVersion: "interval-v1",
      retentionScore: score,
      actualIntervalDays,
      plannedIntervalDays: Number(saved.beforeInterval || BASE_INTERVALS[priorIndex]) || null,
      previousStabilityDays,
      stabilityDays,
      bestStabilityDays: Math.max(Number(study.bestStabilityDays || 0), stabilityDays),
      maxIntervalPassStreak: score >= 70 && actualIntervalDays >= 30
        ? Number(study.maxIntervalPassStreak || 0) + 1
        : (score < 70 ? 0 : Number(study.maxIntervalPassStreak || 0)),
      ...existing,
      suggestedIntervalDays: BASE_INTERVALS[nextIndex],
    };
  }

  function request(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  async function loadRecords(draft) {
    const database = await new Promise((resolve, reject) => {
      const open = global.indexedDB.open(DB_NAME);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error || new Error("复习数据库打不开"));
      open.onupgradeneeded = () => {
        open.transaction.abort();
        reject(new Error("复习数据库不存在，拒绝创建空库"));
      };
    });
    try {
      const rows = {};
      for (const store of STORES) {
        if (!database.objectStoreNames.contains(store)) throw new Error(`复习数据库缺少 ${store}`);
        rows[store] = await request(database.transaction(store).objectStore(store).getAll());
      }
      const saved = rows.logs.find((row) => row.externalDraftId === draft.draftId);
      const study = rows.study.find((row) => row.id === (saved?.sourceId || draft.sourceId || draft.target?.sourceId));
      if (!saved || !study) throw new Error("没有找到同一草稿的已确认记录");
      return {
        saved,
        study,
        state: {
          settings: rows.settings[0] || {}, tags: rows.tags, study: rows.study,
          mistakes: rows.mistakes, logs: rows.logs, tasks: rows.tasks,
        },
      };
    } finally { database.close(); }
  }

  async function sha256(value) {
    const digest = await global.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function buildReceipt(draft, { saved, study, state }) {
    const generatedAt = now();
    const nextTask = (state.tasks || [])
      .filter((task) => task.status === "pending" && task.sourceType === "study" && task.sourceId === study.id && !task.isCram)
      .sort((left, right) => String(left.scheduledDate || "").localeCompare(String(right.scheduledDate || "")))[0];
    const scheduleMetrics = {
      ...derivedIntervalMetrics(draft, saved, study, state),
      nextReviewDate: nextTask?.scheduledDate || nextTask?.earliestDate || "",
      nextIntervalDays: nextTask?.intervalDays ?? saved.afterInterval ?? null,
    };
    const base = {
      format_version: 3,
      generated_at: generatedAt,
      confirmation: {
        draft_id: draft.draftId,
        session_id: draft.sessionId || "",
        source_type: saved.sourceType || "study",
        source_id: saved.sourceId || study.id,
        manager_log_id: saved.logId || saved.id || "",
        title: study.title || draft.title || "",
        date: saved.date || draft.date || generatedAt.slice(0, 10),
        result: saved.result || "",
        recall_percent: saved.recallPercent,
        score_authority: saved.scoreAuthority || draft.scoreAuthority || "",
        section_scores: saved.sectionScores?.length ? saved.sectionScores : (draft.sectionScores || []),
        diagnostic_metrics: scheduleMetrics,
        notes: saved.notes || draft.notes || "",
        duplicate: Boolean(saved.duplicate),
        dialog_visible_at: draft.dialogVisibleAt || "",
        browser_confirmed_at: draft.browserConfirmedAt || draft.confirmedAt || "",
        receipt_downloaded_at: generatedAt,
      },
      state,
      bridge: readBridge(),
    };
    return { ...base, content_hash: await sha256(JSON.stringify(base)) };
  }

  function emitReceipt(payload, draftId) {
    const safeId = String(draftId).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 100) || "review";
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = global.document.createElement("a");
    anchor.href = url;
    anchor.download = `memory-review-auto-sync-${now().slice(0, 10)}-${safeId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function retryReceipt(draftId, dependencies = {}) {
    const draft = readBridge().reviewDrafts.find((item) => item.draftId === draftId);
    if (!draft || draft.status !== "confirmed") throw new Error("草稿尚未在浏览器确认");
    patchDraft(draftId, { receiptDownloadStatus: "retry_requested", receiptDownloadError: "" });
    try {
      const records = await (dependencies.loadRecords || loadRecords)(draft);
      const payload = await buildReceipt(draft, records);
      (dependencies.emitReceipt || emitReceipt)(payload, draftId);
      patchDraft(draftId, { receiptDownloadStatus: "downloaded", receiptDownloadedAt: now(), receiptDownloadError: "" });
      return payload;
    } catch (error) {
      patchDraft(draftId, { receiptDownloadStatus: "failed", receiptDownloadError: String(error?.message || error) });
      throw error;
    }
  }

  function renderRecovery() {
    if (!global.document?.body) return;
    const drafts = readBridge().reviewDrafts;
    const retryDraft = drafts.find((item) => item.status === "confirmed"
      && ["failed", "retry_requested"].includes(item.receiptDownloadStatus));
    const pendingDraft = !global.document.getElementById("codexReviewDraftModal")
      ? drafts.find((item) => item.status === "pending") : null;
    const draft = retryDraft || pendingDraft;
    let banner = global.document.getElementById(BANNER_ID);
    if (!draft) { banner?.remove(); return; }
    if (!banner) {
      banner = global.document.createElement("aside");
      banner.id = BANNER_ID;
      banner.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:99999;max-width:360px;padding:14px;border:1px solid #d59b27;border-radius:12px;background:#fff8e8;box-shadow:0 8px 28px #0002;font:14px/1.5 system-ui";
      global.document.body.appendChild(banner);
    }
    banner.innerHTML = retryDraft
      ? "<strong>记录已确认，回执仍待下载</strong><br><span>重新下载不会重复写入复习记录。</span><br>"
      : "<strong>Codex 草稿已安全保留</strong><br><span>管理器初始化未完成，可重新载入同一草稿。</span><br>";
    const button = global.document.createElement("button");
    button.type = "button";
    button.textContent = retryDraft ? "重新下载确认回执" : "重新载入草稿";
    button.style.cssText = "margin-top:8px;padding:7px 10px;border:0;border-radius:8px;background:#7a5310;color:white";
    button.onclick = async () => {
      button.disabled = true;
      if (!retryDraft) {
        showWhenReady();
        if (!global.document.getElementById("codexReviewDraftModal")) global.location.reload();
        return;
      }
      try { await retryReceipt(draft.draftId); }
      catch (error) { button.disabled = false; button.textContent = `下载失败，重试：${String(error?.message || error).slice(0, 30)}`; }
    };
    banner.appendChild(button);
  }

  function renderAuthoritativeScore(draft) {
    const summary = global.document?.getElementById("codexReviewDraftSummary");
    if (!summary || !draft) return;
    const title = global.document.createElement("h4");
    title.textContent = draft.title || "未命名章节";
    const meta = global.document.createElement("div");
    meta.className = "meta";
    for (const value of [
      draft.date || now().slice(0, 10),
      `数据库正式记忆分 ${Number(draft.overallScore)}%`,
      "来源：Codex 复习助手（SQLite）",
    ]) {
      const span = global.document.createElement("span");
      span.textContent = value;
      meta.appendChild(span);
    }
    const explanation = global.document.createElement("p");
    explanation.className = "body-text muted";
    explanation.textContent = "该分数只读，管理器不会按分项重新判分；本页只生成复习日志、稳定跨度和下次日期。";
    const notes = global.document.createElement("p");
    notes.className = draft.notes ? "body-text manager-note-v2" : "body-text muted";
    notes.textContent = draft.notes || "没有备注。";
    summary.replaceChildren(title, meta, explanation, notes);
  }

  function installScoreAuthorityGuard() {
    if (typeof global.persistReviewForm !== "function" || global.persistReviewForm.__sqliteScoreAuthority) return;
    const originalPersistReviewForm = global.persistReviewForm;
    const guardedPersistReviewForm = async function guardedPersistReviewForm(form) {
      const data = new global.FormData(form);
      if (String(data.get("externalSource") || "") !== SOURCE) {
        return originalPersistReviewForm(form);
      }
      const draftId = String(data.get("externalDraftId") || "");
      const draft = readBridge().reviewDrafts.find((item) => item.draftId === draftId);
      if (!draft || draft.scoreAuthority !== "sqlite") {
        if (typeof global.toast === "function") global.toast("Codex 草稿缺少 SQLite 分数权威标记，已拒绝写入。");
        return null;
      }
      const scoreInput = form.querySelector("[name='recallPercent']");
      if (scoreInput) scoreInput.value = String(draft.overallScore);
      const sectionInput = form.querySelector("[name='sectionScoresJson']");
      if (sectionInput) sectionInput.value = "[]";
      const saved = await originalPersistReviewForm(form);
      return saved ? {
        ...saved,
        recallPercent: draft.overallScore,
        sectionScores: [],
        scoreAuthority: "sqlite",
        diagnosticMetrics: draft.diagnosticMetrics || {},
      } : saved;
    };
    guardedPersistReviewForm.__sqliteScoreAuthority = true;
    global.persistReviewForm = guardedPersistReviewForm;
  }

  function showWhenReady() {
    if (typeof global.handleCodexReviewDraftFromHash === "function"
        && global.document?.getElementById("codexReviewDraftModal")) {
      Promise.resolve(global.handleCodexReviewDraftFromHash()).catch(() => {});
    }
  }

  function install() {
    captureFromHash();
    const dialogPrototype = global.HTMLDialogElement?.prototype;
    if (dialogPrototype?.showModal && !dialogPrototype.showModal.__codexHandoffV2) {
      const originalShowModal = dialogPrototype.showModal;
      const wrappedShowModal = function wrappedCodexDialog() {
        const result = originalShowModal.call(this);
        if (this.id === "codexReviewDraftModal") {
          const draft = readBridge().reviewDrafts.find((item) => item.status === "pending"
            || ["failed", "retry_requested"].includes(item.receiptDownloadStatus));
          if (draft) {
            patchDraft(draft.draftId, { dialogVisibleAt: draft.dialogVisibleAt || now() });
            renderAuthoritativeScore(draft);
          }
        }
        return result;
      };
      wrappedShowModal.__codexHandoffV2 = true;
      dialogPrototype.showModal = wrappedShowModal;
    }
    global.addEventListener("hashchange", () => {
      if (captureFromHash()) global.setTimeout(showWhenReady, 0);
    });
    global.addEventListener("pageshow", () => {
      if (captureFromHash()) global.setTimeout(showWhenReady, 0);
      renderRecovery();
    });
    global.document?.addEventListener("DOMContentLoaded", () => {
      installScoreAuthorityGuard();
      global.document.addEventListener("click", (event) => {
        if (event.target?.closest?.("#confirmCodexReviewDraftBtn")) {
          const draft = readBridge().reviewDrafts.find((item) => item.status === "pending");
          if (draft && draft.scoreAuthority !== "sqlite") {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (typeof global.toast === "function") global.toast("这条旧草稿没有 SQLite 分数权威标记，请重新生成。");
          }
        }
      }, true);
      // Patch receipt creation while the live app retains all other data and UI ownership.
      if (typeof global.downloadReviewAutoSync === "function") {
        global.downloadReviewAutoSync = async (draft, study, saved) => {
          patchDraft(draft.draftId, {
            status: "confirmed",
            browserConfirmedAt: draft.browserConfirmedAt || now(),
            receiptDownloadStatus: "pending",
            receiptDownloadError: "",
          });
          try {
            const records = await loadRecords(draft);
            records.study = study || records.study;
            records.saved = saved || records.saved;
            const payload = await buildReceipt(
              readBridge().reviewDrafts.find((item) => item.draftId === draft.draftId) || draft,
              records,
            );
            emitReceipt(payload, draft.draftId);
            patchDraft(draft.draftId, { receiptDownloadStatus: "downloaded", receiptDownloadedAt: now(), receiptDownloadError: "" });
            return payload;
          } catch (error) {
            patchDraft(draft.draftId, {
              status: "confirmed",
              receiptDownloadStatus: "failed",
              receiptDownloadError: String(error?.message || error),
            });
            throw error;
          }
        };
      }
      renderRecovery();
      global.setTimeout(renderRecovery, 3000);
    }, { once: true });
  }

  global.CodexHandoffV2 = Object.freeze({ captureFromHash, readBridge, patchDraft, retryReceipt, buildReceipt });
  install();
})(globalThis);
