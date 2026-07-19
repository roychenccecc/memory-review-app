(function reviewMatcherModule(root, factory) {
  const canonicalSubjects = typeof module === "object" && module.exports
    ? require("./canonical-subjects.js")
    : root?.CanonicalSubjects;
  const api = factory(canonicalSubjects);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ReviewMatcher = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createReviewMatcher(canonicalSubjects) {
  const SUBJECT_ALIASES = new Map([
    ["普心", "普通心理学"],
    ["普通心理学", "普通心理学"],
    ["发展", "发展心理学"],
    ["发心", "发展心理学"],
    ["发展心理学", "发展心理学"],
    ["实验", "实验心理学"],
    ["实心", "实验心理学"],
    ["实验心理学", "实验心理学"],
    ["统计", "心理统计学"],
    ["心统", "心理统计学"],
    ["心理统计", "心理统计学"],
    ["心理学统计", "心理统计学"],
    ["心理统计学", "心理统计学"],
    ["行为科学统计", "心理统计学"],
    ["教育", "教育心理学"],
    ["教心", "教育心理学"],
    ["教育心理学", "教育心理学"],
    ["测量", "心理测量学"],
    ["测心", "心理测量学"],
    ["心理测量", "心理测量学"],
    ["心理测量学", "心理测量学"],
  ]);
  const SUBJECT_PREFIXES = [...SUBJECT_ALIASES.keys()].sort((a, b) => b.length - a.length);
  const GENERIC_CHAPTER_WORDS = ["心理学", "推断统计", "心理统计", "基础", "第一章", "第二章"];

  function normalizeDisplay(value) {
    return String(value || "")
      .replace(/[《》"'“”‘’]/g, "")
      .replace(/[>＞/\\\-—_：:，,、]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function compact(value) {
    return String(value || "")
      .replace(/[《》"'“”‘’\s>＞/\\\-—_：:，,、。.!！?？()（）[\]【】]/g, "")
      .trim();
  }

  function normalizeSubject(value) {
    const key = compact(value);
    return canonicalSubjects?.canonicalSubjectName(key) || SUBJECT_ALIASES.get(key) || key;
  }

  function stripLeadingOrdinal(value) {
    return String(value || "")
      .replace(/^\s*(第\s*)?([一二三四五六七八九十百千万零〇两]+|\d+)\s*(章|节|讲|单元)?\s*/u, "")
      .trim();
  }

  function splitSubjectAndChapter(value) {
    const normalized = normalizeDisplay(value);
    const directPrefix = SUBJECT_PREFIXES.find((prefix) => (
      normalized === prefix || normalized.startsWith(`${prefix} `)
    ));
    if (directPrefix) {
      return {
        subject: normalizeSubject(directPrefix),
        chapter: compact(stripLeadingOrdinal(normalized.slice(directPrefix.length).trim())),
      };
    }
    const [first = "", ...rest] = normalized.split(" ");
    return {
      subject: normalizeSubject(first),
      chapter: compact(stripLeadingOrdinal(rest.join(" "))),
    };
  }

  function reducedChapter(value) {
    let result = compact(stripLeadingOrdinal(value));
    for (const word of GENERIC_CHAPTER_WORDS) result = result.replaceAll(word, "");
    return result || compact(stripLeadingOrdinal(value));
  }

  function bigrams(value) {
    const text = compact(value);
    if (text.length < 2) return text ? [text] : [];
    return Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2));
  }

  function diceSimilarity(left, right) {
    const a = bigrams(left);
    const b = bigrams(right);
    if (!a.length || !b.length) return left === right ? 1 : 0;
    const counts = new Map();
    for (const token of a) counts.set(token, (counts.get(token) || 0) + 1);
    let overlap = 0;
    for (const token of b) {
      const count = counts.get(token) || 0;
      if (!count) continue;
      overlap += 1;
      counts.set(token, count - 1);
    }
    return (2 * overlap) / (a.length + b.length);
  }

  function levenshteinSimilarity(left, right) {
    const a = compact(left);
    const b = compact(right);
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= b.length; j += 1) {
        current[j] = Math.min(
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      previous.splice(0, previous.length, ...current);
    }
    return 1 - previous[b.length] / Math.max(a.length, b.length);
  }

  function characterJaccard(left, right) {
    const a = new Set(compact(left));
    const b = new Set(compact(right));
    if (!a.size || !b.size) return 0;
    const overlap = [...a].filter((value) => b.has(value)).length;
    return overlap / new Set([...a, ...b]).size;
  }

  function chapterSimilarity(left, right) {
    const a = compact(stripLeadingOrdinal(left));
    const b = compact(stripLeadingOrdinal(right));
    if (!a || !b) return 0;
    if (a === b) return 1;
    if ((a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 2) return 0.94;
    const reducedA = reducedChapter(a);
    const reducedB = reducedChapter(b);
    if (reducedA === reducedB) return 0.97;
    if ((reducedA.includes(reducedB) || reducedB.includes(reducedA)) && Math.min(reducedA.length, reducedB.length) >= 2) return 0.92;
    return Math.max(
      diceSimilarity(reducedA, reducedB),
      levenshteinSimilarity(reducedA, reducedB),
      characterJaccard(reducedA, reducedB) * 0.9,
    );
  }

  function scoreCandidate(targetInput, row) {
    const target = typeof targetInput === "string" ? splitSubjectAndChapter(targetInput) : targetInput;
    const candidate = splitSubjectAndChapter(row.title || "");
    if (target.subject && candidate.subject && target.subject !== candidate.subject) {
      return { ...row, score: 0, reason: "科目不同", similarity: 0 };
    }
    let score = 0;
    const reasons = [];
    if (target.subject && candidate.subject === target.subject) {
      score += 35;
      reasons.push("科目一致");
    }
    const similarity = chapterSimilarity(target.chapter, candidate.chapter);
    if (similarity >= 0.98) {
      score += 45;
      reasons.push("章节精确一致");
    } else if (similarity >= 0.88) {
      score += 40;
      reasons.push(`章节高度相似 ${Math.round(similarity * 100)}%`);
    } else if (similarity >= 0.72) {
      score += 32;
      reasons.push(`章节关键词相似 ${Math.round(similarity * 100)}%`);
    } else if (similarity >= 0.55) {
      score += 22;
      reasons.push(`章节部分相似 ${Math.round(similarity * 100)}%`);
    }
    const targetTokens = [target.subject, reducedChapter(target.chapter)].filter(Boolean);
    const pathMatch = (row.tagPaths || []).some((pathValue) => {
      const canonicalPath = canonicalSubjects?.canonicalizeTagPath(pathValue) || pathValue;
      const normalized = compact(canonicalPath);
      return targetTokens.every((token) => normalized.includes(token));
    });
    if (pathMatch) {
      score += 15;
      reasons.push("知识点路径一致");
    }
    if (row.taskId) {
      score += 5;
      reasons.push("有待复习任务");
    }
    return {
      ...row,
      score: Math.max(0, Math.min(100, Math.round(score))),
      reason: reasons.join("，") || "弱匹配",
      similarity,
    };
  }

  function rankCandidates(targetInput, rows, options = {}) {
    const preferredSourceId = String(options.preferredSourceId || "");
    const preferred = preferredSourceId
      ? rows.find((row) => row.sourceId === preferredSourceId)
      : null;
    if (preferred) {
      return [{ ...preferred, score: 100, similarity: 1, reason: "已确认绑定" }];
    }
    return rows
      .map((row) => scoreCandidate(targetInput, row))
      .filter((row) => row.score >= (options.minimumScore ?? 55))
      .sort((a, b) => b.score - a.score || b.similarity - a.similarity || String(a.title).localeCompare(String(b.title), "zh-CN"))
      .slice(0, options.limit ?? 5);
  }

  return {
    normalizeDisplay,
    compact,
    normalizeSubject,
    stripLeadingOrdinal,
    splitSubjectAndChapter,
    chapterSimilarity,
    scoreCandidate,
    rankCandidates,
  };
});
