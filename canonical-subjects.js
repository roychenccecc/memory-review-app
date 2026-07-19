(function canonicalSubjectsModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CanonicalSubjects = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCanonicalSubjects() {
  const SUBJECT_GROUPS = [
    { canonical: "普通心理学", aliases: ["普通心理学", "普心"] },
    { canonical: "发展心理学", aliases: ["发展心理学", "发展", "发心"] },
    { canonical: "教育心理学", aliases: ["教育心理学", "教育", "教心"] },
    { canonical: "实验心理学", aliases: ["实验心理学", "实验", "实心"] },
    {
      canonical: "心理统计学",
      aliases: [
        "心理统计学",
        "统计",
        "心统",
        "心理统计",
        "心理学统计",
        "行为科学统计",
        "心理学统计（行为科学统计）",
      ],
    },
    { canonical: "心理测量学", aliases: ["心理测量学", "心理测量", "测量", "测心"] },
  ];
  const SUBJECT_ALIASES = new Map(
    SUBJECT_GROUPS.flatMap(({ canonical, aliases }) => aliases.map((alias) => [compactSubject(alias), canonical])),
  );
  const SUBJECT_PREFIXES = [...new Set(SUBJECT_GROUPS.flatMap(({ aliases }) => aliases.flatMap((alias) => [
    alias,
    alias.replaceAll("（", "(").replaceAll("）", ")"),
  ])))].sort((left, right) => right.length - left.length);
  const IMPORTANCE_RANK = { low: 0, medium: 1, high: 2, veryHigh: 3 };

  function compactSubject(value) {
    return String(value || "")
      .replace(/[《》"'“”‘’\s>＞/\\\-—_：:，,、。.!！?？()（）[\]【】]/g, "")
      .trim();
  }

  function canonicalSubjectName(value) {
    const original = String(value || "").trim();
    return SUBJECT_ALIASES.get(compactSubject(original)) || original;
  }

  function canonicalizeSubjectPrefix(value) {
    const original = String(value || "");
    const leadingWhitespace = original.match(/^\s*/)?.[0] || "";
    const body = original.slice(leadingWhitespace.length);
    const prefix = SUBJECT_PREFIXES.find((candidate) => {
      if (!body.startsWith(candidate)) return false;
      const next = body.slice(candidate.length);
      return !next || /^(?:\s|>|＞|→|\/|\\|-|—|_|：|:|，|,|、)/.test(next);
    });
    if (!prefix) return original.trim();
    return `${canonicalSubjectName(prefix)}${body.slice(prefix.length)}`.trim();
  }

  function canonicalizeTagPath(value) {
    return canonicalizeSubjectPrefix(String(value || "")
      .replaceAll("＞", ">")
      .replaceAll("→", ">")
      .trim());
  }

  function canonicalizeChapterTitle(value) {
    return canonicalizeSubjectPrefix(value);
  }

  function planTagRootMigration(input = {}, options = {}) {
    const updatedAt = options.updatedAt || new Date().toISOString();
    const originalTags = Array.isArray(input.tags) ? input.tags : [];
    const originalStudy = Array.isArray(input.study) ? input.study : [];
    const originalMistakes = Array.isArray(input.mistakes) ? input.mistakes : [];
    const originalLogs = Array.isArray(input.logs) ? input.logs : [];
    const tags = originalTags.map((tag) => ({ ...tag }));
    const removedTagIds = new Set();
    const idRewrites = new Map();
    const touchedTagIds = new Set();

    function liveChildren(parentId) {
      return tags.filter((tag) => !removedTagIds.has(tag.id) && (tag.parentId || "") === parentId);
    }

    function markTag(tag) {
      tag.updatedAt = updatedAt;
      touchedTagIds.add(tag.id);
    }

    function mergeMetadata(target, source) {
      let changed = false;
      const targetRank = IMPORTANCE_RANK[target.importance] ?? -1;
      const sourceRank = IMPORTANCE_RANK[source.importance] ?? -1;
      if (sourceRank > targetRank) {
        target.importance = source.importance;
        changed = true;
      }
      if (!target.color && source.color) {
        target.color = source.color;
        changed = true;
      }
      if (!target.tagType && source.tagType) {
        target.tagType = source.tagType;
        changed = true;
      }
      const questionTypes = [...new Set([...(target.questionTypes || []), ...(source.questionTypes || [])])];
      if (questionTypes.length !== (target.questionTypes || []).length) {
        target.questionTypes = questionTypes;
        changed = true;
      }
      const reviewNotes = mergeUniqueText(target.reviewNotes, source.reviewNotes);
      if (reviewNotes !== (target.reviewNotes || "")) {
        target.reviewNotes = reviewNotes;
        changed = true;
      }
      if (changed) markTag(target);
    }

    function siblingMatch(targetParent, sourceChild) {
      const sourceName = String(sourceChild.name || "").trim();
      return liveChildren(targetParent.id).find((candidate) => (
        candidate.id !== sourceChild.id
        && String(candidate.name || "").trim() === sourceName
      ));
    }

    function mergeNode(target, source) {
      if (!target || !source || target.id === source.id || removedTagIds.has(source.id)) return;
      mergeMetadata(target, source);
      for (const child of [...liveChildren(source.id)]) {
        const existingChild = siblingMatch(target, child);
        if (existingChild) {
          mergeNode(existingChild, child);
        } else {
          child.parentId = target.id;
          markTag(child);
        }
      }
      idRewrites.set(source.id, target.id);
      removedTagIds.add(source.id);
    }

    for (const { canonical } of SUBJECT_GROUPS) {
      const roots = tags
        .filter((tag) => !removedTagIds.has(tag.id) && !tag.parentId && canonicalSubjectName(tag.name) === canonical)
        .sort(tagSurvivorOrder(canonical));
      if (!roots.length) continue;
      const survivor = roots[0];
      if (survivor.name !== canonical) {
        survivor.name = canonical;
        markTag(survivor);
      }
      for (const duplicate of roots.slice(1)) mergeNode(survivor, duplicate);
    }

    function resolvedTagId(id) {
      let current = id;
      const seen = new Set();
      while (idRewrites.has(current) && !seen.has(current)) {
        seen.add(current);
        current = idRewrites.get(current);
      }
      return current;
    }

    for (const tag of tags) {
      if (removedTagIds.has(tag.id) || !tag.parentId) continue;
      const resolvedParent = resolvedTagId(tag.parentId);
      if (resolvedParent !== tag.parentId) {
        tag.parentId = resolvedParent;
        markTag(tag);
      }
    }

    function rewriteTagIds(ids) {
      if (!Array.isArray(ids)) return ids;
      return [...new Set(ids.map(resolvedTagId))];
    }

    function rewriteItem(item) {
      const nextTagIds = rewriteTagIds(item.tagIds);
      return arraysEqual(nextTagIds, item.tagIds) ? item : { ...item, tagIds: nextTagIds, updatedAt };
    }

    function rewriteLog(log) {
      let changed = false;
      const next = { ...log };
      if (Array.isArray(log.tagIds)) {
        next.tagIds = rewriteTagIds(log.tagIds);
        changed = !arraysEqual(next.tagIds, log.tagIds);
      }
      if (log.tagId) {
        next.tagId = resolvedTagId(log.tagId);
        changed = changed || next.tagId !== log.tagId;
      }
      if (Array.isArray(log.sectionScores)) {
        const rewritten = rewriteAndDedupeSectionScores(log.sectionScores, resolvedTagId);
        next.sectionScores = rewritten.rows;
        changed = changed || rewritten.changed;
      }
      return changed ? { ...next, updatedAt } : log;
    }

    const nextTags = tags.filter((tag) => !removedTagIds.has(tag.id));
    const nextStudy = originalStudy.map(rewriteItem);
    const nextMistakes = originalMistakes.map(rewriteItem);
    const nextLogs = originalLogs.map(rewriteLog);
    const changedTags = nextTags.filter((tag) => touchedTagIds.has(tag.id));
    const changedStudy = nextStudy.filter((row, index) => row !== originalStudy[index]);
    const changedMistakes = nextMistakes.filter((row, index) => row !== originalMistakes[index]);
    const changedLogs = nextLogs.filter((row, index) => row !== originalLogs[index]);

    return {
      changed: Boolean(removedTagIds.size || changedTags.length || changedStudy.length || changedMistakes.length || changedLogs.length),
      tags: nextTags,
      study: nextStudy,
      mistakes: nextMistakes,
      logs: nextLogs,
      changedTags,
      changedStudy,
      changedMistakes,
      changedLogs,
      removedTagIds: [...removedTagIds],
      idRewrites: Object.fromEntries([...idRewrites].map(([from, to]) => [from, resolvedTagId(to)])),
    };
  }

  function tagSurvivorOrder(canonical) {
    return (left, right) => {
      const leftCanonical = left.name === canonical ? 0 : 1;
      const rightCanonical = right.name === canonical ? 0 : 1;
      if (leftCanonical !== rightCanonical) return leftCanonical - rightCanonical;
      const leftCreated = left.createdAt || "";
      const rightCreated = right.createdAt || "";
      if (leftCreated !== rightCreated) return leftCreated.localeCompare(rightCreated);
      return String(left.id || "").localeCompare(String(right.id || ""));
    };
  }

  function arraysEqual(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }

  function mergeUniqueText(targetValue, sourceValue) {
    const target = String(targetValue || "").trim();
    const source = String(sourceValue || "").trim();
    if (!target) return source;
    if (!source || target === source || target.includes(source)) return target;
    if (source.includes(target)) return source;
    return `${target}\n\n${source}`;
  }

  function rewriteAndDedupeSectionScores(rows, resolveTagId = (tagId) => tagId, canonicalizePaths = false) {
    if (!Array.isArray(rows)) return { rows, changed: false };
    const result = [];
    const indexByTagId = new Map();
    let changed = false;
    for (const section of rows) {
      if (!section || typeof section !== "object") {
        result.push(section);
        continue;
      }
      let next = section;
      if (section.tagId) {
        const tagId = resolveTagId(section.tagId);
        if (tagId !== section.tagId) {
          next = { ...next, tagId };
          changed = true;
        }
      }
      if (canonicalizePaths && typeof section.tagPath === "string") {
        const tagPath = canonicalizeTagPath(section.tagPath);
        if (tagPath !== section.tagPath) {
          next = { ...next, tagPath };
          changed = true;
        }
      }
      if (!next.tagId || !indexByTagId.has(next.tagId)) {
        if (next.tagId) indexByTagId.set(next.tagId, result.length);
        result.push(next);
        continue;
      }
      const index = indexByTagId.get(next.tagId);
      result[index] = mergeSectionScoreRows(result[index], next);
      changed = true;
    }
    return { rows: changed ? result : rows, changed };
  }

  function mergeSectionScoreRows(left, right) {
    const preferred = compareSectionScoreQuality(left, right) >= 0 ? left : right;
    const fallback = preferred === left ? right : left;
    const merged = { ...preferred };
    for (const [key, value] of Object.entries(fallback || {})) {
      if (!isMeaningfulValue(merged[key]) && isMeaningfulValue(value)) merged[key] = value;
    }
    merged.tagId = preferred.tagId || fallback.tagId;
    const weightedRows = [left, right].filter((row) => (
      isMeaningfulValue(row?.score)
      && Number.isFinite(Number(row.score))
      && isMeaningfulValue(row?.weight)
      && Number.isFinite(Number(row.weight))
      && Number(row.weight) > 0
    ));
    if (weightedRows.length) {
      const totalWeight = weightedRows.reduce((sum, row) => sum + Number(row.weight), 0);
      const weightedScore = weightedRows.reduce((sum, row) => sum + Number(row.score) * Number(row.weight), 0);
      // Keep raw precision: downstream rendering may round, but migration must preserve the exact aggregate.
      merged.score = weightedScore / totalWeight;
      merged.weight = totalWeight;
    }
    return merged;
  }

  function compareSectionScoreQuality(left, right) {
    const leftQuality = sectionScoreQuality(left);
    const rightQuality = sectionScoreQuality(right);
    for (let index = 0; index < leftQuality.length; index += 1) {
      if (leftQuality[index] !== rightQuality[index]) return leftQuality[index] - rightQuality[index];
    }
    return 0;
  }

  function sectionScoreQuality(row = {}) {
    const meaningfulEntries = Object.entries(row).filter(([, value]) => isMeaningfulValue(value));
    const extraFields = meaningfulEntries.filter(([key]) => !["tagId", "tagPath", "score", "weight"].includes(key)).length;
    const hasScore = isMeaningfulValue(row.score) && Number.isFinite(Number(row.score)) ? 1 : 0;
    const hasWeight = isMeaningfulValue(row.weight) && Number.isFinite(Number(row.weight)) && Number(row.weight) > 0 ? 1 : 0;
    // Completeness wins before magnitude so migration cannot silently improve a historical score.
    return [
      hasScore + hasWeight,
      meaningfulEntries.length,
      extraFields,
      hasWeight ? Number(row.weight) : -1,
      JSON.stringify(row).length,
      hasScore ? Number(row.score) : -1,
    ];
  }

  function isMeaningfulValue(value) {
    if (value == null || value === "") return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  }

  function canonicalizeBridgeState(bridge = {}, migration = {}) {
    const idRewrites = migration?.idRewrites || {};
    const resolveTagId = (tagId) => {
      let current = tagId;
      const seen = new Set();
      while (idRewrites[current] && !seen.has(current)) {
        seen.add(current);
        current = idRewrites[current];
      }
      return current;
    };
    const next = { ...bridge };
    for (const key of ["dueReviews", "completedReviews", "reviewCompletions", "studyIndex"]) {
      if (!Array.isArray(bridge[key])) continue;
      next[key] = bridge[key].map(canonicalizeBridgeRow);
    }
    if (Array.isArray(bridge.learningDrafts)) {
      next.learningDrafts = bridge.learningDrafts.map(canonicalizeBridgeRow);
    }
    if (Array.isArray(bridge.reviewDrafts)) {
      next.reviewDrafts = bridge.reviewDrafts.map((draft) => {
        const sectionScores = rewriteAndDedupeSectionScores(draft.sectionScores, resolveTagId, true).rows;
        return {
          ...canonicalizeBridgeRow(draft),
          subject: canonicalSubjectName(draft.subject),
          target: draft.target ? canonicalizeBridgeRow(draft.target) : draft.target,
          sectionScores,
        };
      });
    }
    if (bridge.reviewBindings && typeof bridge.reviewBindings === "object") {
      const entries = Object.entries(bridge.reviewBindings)
        .sort(([left], [right]) => Number(canonicalizeChapterTitle(left) === left) - Number(canonicalizeChapterTitle(right) === right));
      next.reviewBindings = Object.fromEntries(entries.map(([key, value]) => [
        canonicalizeChapterTitle(key),
        canonicalizeBridgeRow(value),
      ]));
    }
    return next;
  }

  function canonicalizeBridgeRow(row) {
    if (!row || typeof row !== "object") return row;
    const next = { ...row };
    if (typeof row.title === "string") next.title = canonicalizeChapterTitle(row.title);
    if (typeof row.subject === "string") next.subject = canonicalSubjectName(row.subject);
    if (typeof row.tagPath === "string") next.tagPath = canonicalizeTagPath(row.tagPath);
    if (Array.isArray(row.tagPaths)) next.tagPaths = row.tagPaths.map(canonicalizeTagPath);
    if (Array.isArray(row.tags)) next.tags = row.tags.map(canonicalizeTagPath);
    return next;
  }

  return {
    SUBJECT_GROUPS,
    canonicalSubjectName,
    canonicalizeSubjectPrefix,
    canonicalizeTagPath,
    canonicalizeChapterTitle,
    canonicalizeBridgeState,
    planTagRootMigration,
  };
});
