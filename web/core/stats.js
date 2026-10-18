// Pass-rate maths. Pure functions, no DOM, no storage.
//
// The one rule that matters: inconclusive is NOT a failure. A room that got
// noisy must not make the robot look worse than it is. passRate therefore
// divides by (pass + fail) only.

const DECIDED = new Set(["pass", "fail"]);

export function emptyBucket() {
  return { trials: 0, pass: 0, fail: 0, inconclusive: 0, skip: 0 };
}

function addTo(bucket, verdict) {
  bucket.trials += 1;
  if (verdict === "pass") bucket.pass += 1;
  else if (verdict === "fail") bucket.fail += 1;
  else if (verdict === "inconclusive") bucket.inconclusive += 1;
  else if (verdict === "skip") bucket.skip += 1;
}

export function passRate(bucket) {
  const decided = bucket.pass + bucket.fail;
  return decided === 0 ? null : bucket.pass / decided;
}

/**
 * @param {Array} trials      session trials
 * @param {Array} utterances  suite utterances (for groupId / tags)
 */
export function summarize(trials, utterances) {
  const byId = new Map(utterances.map((u) => [u.id, u]));
  const byGroup = {};
  const byTag = {};
  const byUtterance = {};
  const latencies = new Map();
  let agreementHits = 0;
  let agreementTotal = 0;

  for (const t of trials) {
    const u = byId.get(t.utteranceId);
    const gid = (u && u.groupId) || "ungrouped";
    const verdict = t.humanVerdict || t.sensorVerdict;

    byGroup[gid] ||= emptyBucket();
    addTo(byGroup[gid], verdict);

    byUtterance[t.utteranceId] ||= emptyBucket();
    addTo(byUtterance[t.utteranceId], verdict);

    for (const tag of (u && u.tags) || []) {
      byTag[tag] ||= emptyBucket();
      addTo(byTag[tag], verdict);
    }

    if (t.sensorVerdict && t.humanVerdict && DECIDED.has(t.sensorVerdict) && DECIDED.has(t.humanVerdict)) {
      agreementTotal += 1;
      if (t.sensorVerdict === t.humanVerdict) agreementHits += 1;
    }

    const lat = t.metrics && t.metrics.latencyMs;
    if (typeof lat === "number" && lat >= 0) {
      if (!latencies.has(t.utteranceId)) latencies.set(t.utteranceId, []);
      latencies.get(t.utteranceId).push(lat);
    }
  }

  const total = emptyBucket();
  for (const t of trials) addTo(total, t.humanVerdict || t.sensorVerdict);

  for (const [uid, bucket] of Object.entries(byUtterance)) {
    const list = latencies.get(uid) || [];
    bucket.medianLatencyMs = list.length ? median(list) : null;
  }

  return {
    totalTrials: total.trials,
    pass: total.pass,
    fail: total.fail,
    inconclusive: total.inconclusive,
    skip: total.skip,
    passRate: passRate(total),
    sensorHumanAgreement: agreementTotal ? agreementHits / agreementTotal : null,
    byGroup,
    byTag,
    byUtterance,
  };
}

export function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

/** Rank utterances worst-first; utterances with no decided trials go last. */
export function rankUtterances(summary, utterances) {
  const byId = new Map(utterances.map((u) => [u.id, u]));
  return Object.entries(summary.byUtterance)
    .map(([uid, b]) => ({
      id: uid,
      text: (byId.get(uid) || {}).text || uid,
      translation: (byId.get(uid) || {}).translation || "",
      groupId: (byId.get(uid) || {}).groupId || "",
      tags: (byId.get(uid) || {}).tags || [],
      ...b,
      rate: passRate(b),
      medianLatencyMs: b.medianLatencyMs,
    }))
    .sort((a, b) => {
      if (a.rate === null && b.rate === null) return a.id.localeCompare(b.id);
      if (a.rate === null) return 1;
      if (b.rate === null) return -1;
      return a.rate - b.rate;
    });
}

/** Tags sorted by failure rate, ignoring tags with too few decided trials. */
export function weakestTags(summary, minTrials = 3) {
  return Object.entries(summary.byTag)
    .map(([tag, b]) => ({ tag, ...b, rate: passRate(b) }))
    .filter((x) => x.rate !== null && x.pass + x.fail >= minTrials)
    .sort((a, b) => a.rate - b.rate);
}

// ------------------------------------------------------------------ exporting

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/** One row per trial, the format you want for a spreadsheet. */
export function trialsCsv(session, utterances) {
  const byId = new Map(utterances.map((u) => [u.id, u]));
  const header = [
    "utterance_id", "text", "group", "round",
    "peak_rms_db", "baseline_rms_db", "frame_diff", "latency_ms",
    "sensor_verdict", "human_verdict", "agreement", "note",
  ];
  const rows = session.trials.map((t) => {
    const u = byId.get(t.utteranceId) || {};
    const m = t.metrics || {};
    return [
      t.utteranceId, u.text || "", u.groupId || "", t.round,
      m.peakRmsDb ?? "", m.baselineRmsDb ?? "", m.frameDiff ?? "", m.latencyMs ?? "",
      t.sensorVerdict, t.humanVerdict ?? "", t.agreement ?? "", t.humanNote ?? "",
    ];
  });
  return "\uFEFF" + toCsv([header, ...rows]);
}

/** One row per utterance, sorted worst-first. */
export function rankingCsv(summary, utterances) {
  const header = ["rank", "utterance_id", "text", "translation", "group", "tags", "trials", "pass", "fail", "inconclusive", "pass_rate", "median_latency_ms"];
  const rows = rankUtterances(summary, utterances).map((r, i) => [
    i + 1, r.id, r.text, r.translation, r.groupId, r.tags.join("|"),
    r.trials, r.pass, r.fail, r.inconclusive,
    r.rate === null ? "" : (r.rate * 100).toFixed(1),
    r.medianLatencyMs ?? "",
  ]);
  return "\uFEFF" + toCsv([header, ...rows]);
}

export function pct(rate) {
  return rate === null || rate === undefined ? "—" : `${Math.round(rate * 100)}%`;
}
