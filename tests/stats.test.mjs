// Tests for the pass-rate maths. Run with: node --test tests/
//
// The rules being pinned down here are the ones that silently corrupt a report
// if they drift: inconclusive must never count as a failure, and a sensor that
// disagrees with the human must show up in the agreement figure.

import test from "node:test";
import assert from "node:assert/strict";

import {
  summarize, passRate, median, rankUtterances, weakestTags,
  trialsCsv, rankingCsv, emptyBucket,
} from "../web/core/stats.js";

const UTTERANCES = [
  { id: "g1-01", groupId: "g1", text: "こんにちは", translation: "hello", tags: ["mora:short", "keigo"] },
  { id: "g1-02", groupId: "g1", text: "ありがとうございます", translation: "thanks", tags: ["mora:mid", "keigo"] },
  { id: "g2-01", groupId: "g2", text: "握手してください", translation: "shake hands", tags: ["mora:mid"] },
];

function trial(utteranceId, round, verdict, extra = {}) {
  return {
    utteranceId,
    round,
    sensorVerdict: verdict,
    humanVerdict: verdict,
    metrics: {},
    ...extra,
  };
}

test("passRate ignores inconclusive and skip", () => {
  const bucket = { trials: 5, pass: 3, fail: 2, inconclusive: 4, skip: 1 };
  assert.equal(passRate(bucket), 0.6);
});

test("passRate is null when nothing was decided", () => {
  assert.equal(passRate({ trials: 3, pass: 0, fail: 0, inconclusive: 3, skip: 0 }), null);
  assert.equal(passRate(emptyBucket()), null);
});

test("summarize separates verdicts and never merges inconclusive into fail", () => {
  const trials = [
    trial("g1-01", 1, "pass"),
    trial("g1-01", 2, "fail"),
    trial("g1-01", 3, "inconclusive"),
    trial("g1-02", 1, "pass"),
  ];
  const s = summarize(trials, UTTERANCES);

  assert.equal(s.totalTrials, 4);
  assert.equal(s.pass, 2);
  assert.equal(s.fail, 1);
  assert.equal(s.inconclusive, 1);
  assert.equal(s.passRate, 2 / 3, "inconclusive must not be in the denominator");

  assert.equal(s.byGroup.g1.trials, 4);
  assert.equal(s.byGroup.g1.inconclusive, 1);
  assert.equal(s.byGroup.g2, undefined, "groups with no trials should not appear");
});

test("human verdict wins over sensor verdict when both exist", () => {
  const trials = [
    { utteranceId: "g1-01", round: 1, sensorVerdict: "pass", humanVerdict: "fail", metrics: {} },
  ];
  const s = summarize(trials, UTTERANCES);
  assert.equal(s.fail, 1);
  assert.equal(s.pass, 0);
});

test("agreement only counts trials where both verdicts are decided", () => {
  const trials = [
    trial("g1-01", 1, "pass"),
    { utteranceId: "g1-01", round: 2, sensorVerdict: "pass", humanVerdict: "fail", metrics: {} },
    { utteranceId: "g1-01", round: 3, sensorVerdict: "inconclusive", humanVerdict: "pass", metrics: {} },
    { utteranceId: "g1-01", round: 4, sensorVerdict: "pass", humanVerdict: null, metrics: {} },
  ];
  const s = summarize(trials, UTTERANCES);
  assert.equal(s.sensorHumanAgreement, 0.5, "1 match out of 2 comparable trials");
});

test("tags aggregate across utterances", () => {
  const trials = [
    trial("g1-01", 1, "pass"),
    trial("g1-02", 1, "fail"),
    trial("g1-02", 2, "fail"),
  ];
  const s = summarize(trials, UTTERANCES);
  assert.equal(s.byTag["mora:short"].pass, 1);
  assert.equal(s.byTag["mora:mid"].fail, 2);
  assert.equal(s.byTag["keigo"].trials, 3);
});

test("median handles odd and even counts", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 3, "rounded mean of the two middle values");
  assert.equal(median([7]), 7);
});

test("rankUtterances puts worst first and excludes untested utterances", () => {
  const trials = [
    trial("g1-01", 1, "pass"),
    trial("g1-02", 1, "fail"),
    trial("g1-02", 2, "fail"),
  ];
  const s = summarize(trials, UTTERANCES);
  const ranked = rankUtterances(s, UTTERANCES);

  assert.equal(ranked[0].id, "g1-02");
  assert.equal(ranked[0].rate, 0);
  assert.equal(ranked.at(-1).id, "g1-01", "best of the tested sorts last");
  assert.equal(ranked.at(-1).rate, 1);
  assert.equal(ranked.length, 2, "g2-01 was never run, so it is not ranked");
});

test("weakestTags drops tags with too few decided trials", () => {
  const trials = [
    trial("g1-01", 1, "fail"),
    trial("g1-02", 1, "fail"),
    trial("g1-02", 2, "fail"),
  ];
  const s = summarize(trials, UTTERANCES);

  const weak = weakestTags(s, 3);
  assert.ok(weak.some((t) => t.tag === "keigo"), "keigo has 3 decided trials");
  assert.ok(!weak.some((t) => t.tag === "mora:short"), "mora:short has only 1");
});

test("CSV escapes commas, quotes and newlines", () => {
  const session = {
    trials: [{
      utteranceId: "g1-01",
      round: 1,
      sensorVerdict: "pass",
      humanVerdict: "pass",
      humanNote: 'said "hello", then left\nsecond line',
      metrics: { peakRmsDb: -31.5, frameDiff: 2.25, latencyMs: 820 },
    }],
  };
  const csv = trialsCsv(session, UTTERANCES);
  assert.ok(csv.startsWith("\uFEFF"), "BOM so Excel reads UTF-8");
  assert.ok(csv.includes('"said ""hello"", then left\nsecond line"'));
  assert.ok(csv.includes("-31.5"));
});

test("rankingCsv emits one row per tested utterance, worst first", () => {
  const trials = [trial("g1-01", 1, "pass"), trial("g1-02", 1, "fail")];
  const s = summarize(trials, UTTERANCES);
  const csv = rankingCsv(s, UTTERANCES);
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");

  assert.equal(lines[0].split(",")[1], "utterance_id");
  assert.ok(lines[1].startsWith("1,g1-02"), "worst utterance ranked first");
  assert.equal(lines.length, 3, "header + the 2 utterances that were run");
});
