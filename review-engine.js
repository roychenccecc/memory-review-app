(function attachReviewEngine(global) {
  "use strict";

  const BASE_INTERVALS = Object.freeze([1, 2, 4, 7, 15, 30]);
  const TAG_SCORE_WEIGHT = Object.freeze({ veryHigh: 5, high: 3, medium: 2, low: 1 });
  const REVIEW_DAY_START_HOUR = 8;
  const TAG_STUDY_RATIO = 0.6;
  const TAG_MISTAKE_RATIO = 0.4;
  const MISTAKE_COUNT_PENALTY = 3;
  const MAX_MISTAKE_PENALTY = 18;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function averageScores(scores = []) {
    if (!scores.length) return 0;
    return Math.round(scores.reduce((sum, score) => sum + Number(score), 0) / scores.length);
  }

  function weightedSectionScore(sectionScores = []) {
    const totalWeight = sectionScores.reduce((sum, section) => sum + (Number(section.weight) || 0), 0);
    if (!totalWeight) return 0;
    const weightedTotal = sectionScores.reduce(
      (sum, section) => sum + Number(section.score) * Number(section.weight),
      0
    );
    return Math.round(weightedTotal / totalWeight);
  }

  function weightedLatestMistakeScore(scores = []) {
    if (scores.length <= 1) return Math.round(scores[0] || 0);
    const latest = scores[0];
    const restAverage = averageScores(scores.slice(1, 10));
    return Math.round(clamp(latest * 0.5 + restAverage * 0.5, 0, 100));
  }

  function aggregateReviewScore(sourceType, scores = [], fallbackScore) {
    const normalized = scores
      .filter((score) => Number.isFinite(Number(score)))
      .map((score) => clamp(Number(score), 0, 100))
      .slice(0, 10);
    if (!normalized.length) {
      return clamp(Number(fallbackScore ?? (sourceType === "study" ? 70 : 60)), 0, 100);
    }
    return sourceType === "mistake"
      ? weightedLatestMistakeScore(normalized)
      : averageScores(normalized);
  }

  function intervalStateAfterReview(item, recallPercent, historicalScore) {
    const previousIndex = clamp(Number(item.currentIntervalIndex ?? 0), 0, BASE_INTERVALS.length - 1);
    let nextIndex = previousIndex;

    if (recallPercent >= 70) {
      nextIndex = Math.min(previousIndex + 1, BASE_INTERVALS.length - 1);
    } else if (recallPercent >= 50) {
      nextIndex = historicalScore < 60 ? Math.max(0, previousIndex - 1) : previousIndex;
    } else if (recallPercent >= 30) {
      nextIndex = Math.max(0, previousIndex - 2);
    } else {
      nextIndex = 0;
    }

    return { index: nextIndex, interval: BASE_INTERVALS[nextIndex] || 1 };
  }

  function resultFromPercent(percent) {
    if (percent >= 85) return "remembered";
    if (percent >= 40) return "unclear";
    return "forgotten";
  }

  function toDateInput(date) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function reviewBusinessDate(date = new Date(), startHour = REVIEW_DAY_START_HOUR) {
    const shifted = new Date(date.getTime() - Number(startHour) * 60 * 60 * 1000);
    return toDateInput(shifted);
  }

  function addDays(dateString, days) {
    const date = new Date(`${dateString}T12:00:00`);
    date.setDate(date.getDate() + Number(days));
    return toDateInput(date);
  }

  function postponedTaskDate(today, scheduledDate) {
    return addDays(maxDate(today, scheduledDate || today), 1);
  }

  function minDate(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a <= b ? a : b;
  }

  function maxDate(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a >= b ? a : b;
  }

  function diffDays(start, end) {
    const a = new Date(`${start}T12:00:00`);
    const b = new Date(`${end}T12:00:00`);
    return Math.round((b - a) / 86400000);
  }

  function decayedMemoryScore(baseScore, lastDate, today) {
    const decay = Math.floor(Math.max(0, diffDays(lastDate, today)) / 7) * 2;
    return clamp(Number(baseScore) - decay, 0, 100);
  }

  function calculatePriorityScore({
    score,
    recallPercent,
    importanceWeight,
    knowledgeWeaknessBonus,
    daysSinceReview,
    isMistake,
    isNewStudy,
    isCram,
    newStudyBonus = 18,
  }) {
    const recencyPenalty = Math.max(0, 12 - daysSinceReview);
    const stableBonus = score >= 80 && recallPercent >= 85 ? -18 : 0;
    const weakGuard = score < 60 ? 12 : score < 80 ? 6 : 0;
    const mistakeGuard = isMistake && recallPercent < 80 ? 10 : 0;
    return (100 - score)
      + importanceWeight
      + knowledgeWeaknessBonus
      + weakGuard
      + mistakeGuard
      + (isNewStudy ? newStudyBonus : 0)
      + stableBonus
      + (isCram ? 20 : 0)
      - recencyPenalty;
  }

  function taskQueueSort(a, b, today) {
    const aEarliest = a.earliestDate || a.scheduledDate || today;
    const bEarliest = b.earliestDate || b.scheduledDate || today;
    const aDue = aEarliest <= today;
    const bDue = bEarliest <= today;
    if (aDue && bDue && (a.priority || 0) !== (b.priority || 0)) {
      return (b.priority || 0) - (a.priority || 0);
    }
    if (aDue !== bDue) return aDue ? -1 : 1;
    if (aEarliest !== bEarliest) return aEarliest.localeCompare(bEarliest);
    return (b.priority || 0) - (a.priority || 0);
  }

  function applyDailyCapacity(tasks = [], options = {}) {
    const today = options.today;
    const limit = clamp(Number(options.limit) || 6, 1, 80);
    const examDate = options.examDate || "";
    const reviewedCount = Math.min(limit, Math.max(0, Number(options.reviewedCount) || 0));
    const counts = new Map([[today, reviewedCount]]);

    return tasks
      .map((task) => ({
        ...task,
        earliestDate: task.earliestDate || task.scheduledDate || today,
      }))
      .filter((task) => !examDate || task.earliestDate <= examDate)
      .sort((a, b) => taskQueueSort(a, b, today))
      .map((task) => {
        let scheduledDate = maxDate(task.earliestDate, today);
        while ((counts.get(scheduledDate) || 0) >= limit) {
          scheduledDate = addDays(scheduledDate, 1);
          if (examDate && scheduledDate > examDate) break;
        }
        if (examDate && scheduledDate > examDate) return { ...task, scheduledDate: "" };
        counts.set(scheduledDate, (counts.get(scheduledDate) || 0) + 1);
        return { ...task, scheduledDate };
      })
      .filter((task) => task.scheduledDate);
  }

  function leafKnowledgeSummary(studyScores = [], mistakeScores = []) {
    const studyScore = studyScores.length ? averageScores(studyScores) : null;
    const mistakeBaseScore = mistakeScores.length ? averageScores(mistakeScores) : null;
    const mistakePenalty = Math.min(mistakeScores.length * MISTAKE_COUNT_PENALTY, MAX_MISTAKE_PENALTY);
    const mistakeScore = mistakeBaseScore == null
      ? null
      : clamp(mistakeBaseScore - mistakePenalty, 0, 100);

    let score = null;
    if (studyScore != null && mistakeScore != null) {
      score = Math.round(studyScore * TAG_STUDY_RATIO + mistakeScore * TAG_MISTAKE_RATIO);
    } else if (studyScore != null) {
      score = studyScore;
    } else if (mistakeScore != null) {
      score = mistakeScore;
    }

    return {
      score,
      studyScore,
      mistakeBaseScore,
      mistakeScore,
      mistakeCount: mistakeScores.length,
    };
  }

  function parentKnowledgeSummary(children = [], directMistakeCount = 0) {
    let weightedTotal = 0;
    let totalWeight = 0;
    let mistakeCount = directMistakeCount;
    for (const child of children) {
      mistakeCount += child.mistakeCount || 0;
      if (child.score == null) continue;
      const weight = TAG_SCORE_WEIGHT[child.importance] || TAG_SCORE_WEIGHT.medium;
      weightedTotal += child.score * weight;
      totalWeight += weight;
    }
    return {
      score: totalWeight ? Math.round(weightedTotal / totalWeight) : null,
      mistakeCount,
    };
  }

  global.ReviewEngine = Object.freeze({
    BASE_INTERVALS,
    TAG_SCORE_WEIGHT,
    REVIEW_DAY_START_HOUR,
    addDays,
    aggregateReviewScore,
    applyDailyCapacity,
    averageScores,
    calculatePriorityScore,
    clamp,
    decayedMemoryScore,
    diffDays,
    intervalStateAfterReview,
    leafKnowledgeSummary,
    maxDate,
    minDate,
    parentKnowledgeSummary,
    postponedTaskDate,
    resultFromPercent,
    reviewBusinessDate,
    toDateInput,
    weightedLatestMistakeScore,
    weightedSectionScore,
  });
})(globalThis);
