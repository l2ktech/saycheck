// SayCheck browser runner.
// Flow: setup → play → sense → one-key verdict → next → results.
// Everything below is deliberately plain DOM: no framework, no build step,
// so the file you edit is the file the browser runs.

import { loadSuite, loadSuiteFromFile, audioUrl, selectUtterances, groupOf } from "./core/suite.js";
import { Sensor, classify } from "./core/sensor.js";
import { Player } from "./core/player.js";
import * as stats from "./core/stats.js";
import * as store from "./core/store.js";

const $ = (id) => document.getElementById(id);
const app = {
  suite: null,
  sensor: new Sensor(),
  player: new Player(),
  state: null,
  queue: [],
  cursor: 0,
  running: false,
  paused: false,
  awaiting: null,
  baselineDb: null,
  activeGroups: new Set(),
};

// ------------------------------------------------------------------ plumbing

function toast(msg, bad = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("bad", bad);
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), bad ? 5200 : 2600);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function showView(name) {
  for (const v of document.querySelectorAll(".view")) v.classList.remove("active");
  $(`view-${name}`).classList.add("active");
  window.scrollTo({ top: 0, behavior: "instant" });
}

function newSessionId() {
  return new Date().toISOString();
}

function deviceInfo() {
  const ua = navigator.userAgent;
  return {
    ua,
    platform: navigator.platform || "",
    mic: app.sensor.status.audio ? "default input" : "",
    camera: app.sensor.status.video ? "default camera" : "",
    screen: `${window.screen.width}x${window.screen.height}@${window.devicePixelRatio || 1}`,
  };
}

// ------------------------------------------------------------------- suite

async function loadSuiteIntoApp(source) {
  try {
    const suite = typeof source === "string"
      ? await loadSuite(source)
      : await loadSuiteFromFile(source);

    app.suite = suite;
    app.activeGroups = new Set(suite.groups.map((g) => g.id));

    $("pill-suite").textContent = `${suite.title} · ${suite.utterances.length} 条`;
    $("pill-suite").className = "pill ok";
    $("suite-info").textContent = `${suite.id} · ${suite.locale || "?"} · ${suite.groups.length} 组`;
    $("count-all").textContent = suite.utterances.length;

    applyDefaults(suite.defaults);
    renderGroupChips();
    updateCounts();

    const existing = store.loadState(suite.id);
    const hasTrials = existing && existing.trials && existing.trials.length;
    $("btn-start").disabled = false;
    $("btn-clear").hidden = !hasTrials;
    if (hasTrials) {
      toast(`发现上次未完成的记录（${existing.trials.length} 轮），点「开始测试」会接着用。`);
    }

    // Warm the audio cache in the background so round 1 is not slow.
    const urls = suite.utterances.map((u) => audioUrl(suite, u)).filter(Boolean);
    app.player.preload(urls.slice(0, 24), 4).then(() => {
      const rest = urls.slice(24);
      if (rest.length) app.player.preload(rest, 2);
    });

    return true;
  } catch (err) {
    console.error(err);
    $("pill-suite").textContent = "套件加载失败";
    $("pill-suite").className = "pill bad";
    toast(err.message, true);
    return false;
  }
}

function applyDefaults(d) {
  $("opt-rounds").value = d.rounds;
  $("opt-gap").value = d.gapMs;
  $("opt-window").value = d.windowMs;
  $("opt-settle").value = d.settleMs;
  $("opt-silence").value = d.silenceMs;
  $("opt-rms").value = d.rmsPeakDb;
  $("opt-motion").value = d.frameDiff;
  $("opt-rule").value = d.rule || "any";
  $("opt-record").checked = !d.recordFailedOnly;
}

function renderGroupChips() {
  const box = $("group-chips");
  box.replaceChildren();
  if (!app.suite) return;
  for (const g of app.suite.groups) {
    const n = app.suite.utterances.filter((u) => u.groupId === g.id).length;
    const chip = document.createElement("button");
    chip.className = "group-chip" + (app.activeGroups.has(g.id) ? " on" : "");
    chip.type = "button";
    chip.innerHTML = `${escapeHtml(g.name)} <span class="n">${n}</span>`;
    chip.onclick = () => {
      if (app.activeGroups.has(g.id)) app.activeGroups.delete(g.id);
      else app.activeGroups.add(g.id);
      chip.classList.toggle("on");
      updateCounts();
    };
    box.appendChild(chip);
  }
}

function updateCounts() {
  const sel = selectUtterances(app.suite, app.activeGroups).length;
  $("count-selected").textContent = sel;
  $("btn-start").disabled = !app.suite || sel === 0;
}

// -------------------------------------------------------------------- setup

async function checkDevices() {
  const status = await app.sensor.init({ audio: true, video: true });
  $("device-audio").textContent = status.audio ? "麦克风 就绪" : "麦克风 不可用";
  $("device-audio").className = "pill " + (status.audio ? "ok" : "warn");
  $("device-video").textContent = status.video ? "摄像头 就绪" : "摄像头 不可用";
  $("device-video").className = "pill " + (status.video ? "ok" : "warn");

  const p = $("pill-sensors");
  if (status.audio && status.video) {
    p.textContent = "声音 + 动作";
    p.className = "pill ok";
  } else if (status.audio) {
    p.textContent = "仅声音";
    p.className = "pill warn";
  } else if (status.video) {
    p.textContent = "仅动作";
    p.className = "pill warn";
  } else {
    p.textContent = "纯人工判定";
    p.className = "pill bad";
  }
  if (status.reason) toast(status.reason, !status.audio);
  app.sensor.attachPreview($("preview"));
  $("footer-hint").textContent = status.audio || status.video
    ? "判定 = 麦克风 RMS + 摄像头帧差 + 人工一键"
    : "传感器不可用，当前为纯人工判定";
}

async function calibrate() {
  if (!app.sensor.canSenseAudio) {
    toast("麦克风不可用，无法校准", true);
    return;
  }
  $("cal-hint").textContent = "采样中，请保持安静…";
  const db = await app.sensor.calibrate(1500);
  if (db === null) {
    $("cal-hint").textContent = "采样失败";
    return;
  }
  app.baselineDb = db;
  $("cal-value").textContent = `${db.toFixed(1)} dB`;
  $("cal-bar").style.width = `${Math.max(0, Math.min(100, (db + 90) / 60 * 100))}%`;
  // Suggest a threshold 18 dB above the floor, clamped to something sane.
  const suggested = Math.round(Math.min(-18, Math.max(-70, db + 18)));
  $("opt-rms").value = suggested;
  $("cal-hint").textContent = `底噪 ${db.toFixed(1)} dB，建议阈值 ${suggested} dB（已填入）`;
}

// --------------------------------------------------------------------- run

function buildQueue() {
  const utts = selectUtterances(app.suite, app.activeGroups);
  const rounds = clampInt($("opt-rounds").value, 1, 50);
  const queue = [];
  for (const u of utts) for (let r = 1; r <= rounds; r += 1) queue.push({ utt: u, round: r });
  return queue;
}

function freshState() {
  return {
    suiteId: app.suite.id,
    suiteTitle: app.suite.title,
    sessionId: newSessionId(),
    startedAt: new Date().toISOString(),
    thresholds: {
      rmsBaselineDb: app.baselineDb,
      rmsPeakDb: Number($("opt-rms").value),
      frameDiff: Number($("opt-motion").value),
      windowMs: clampInt($("opt-window").value, 500, 30000),
      settleMs: clampInt($("opt-settle").value, 0, 5000),
      silenceMs: clampInt($("opt-silence").value, 200, 10000),
      rule: $("opt-rule").value,
    },
    device: deviceInfo(),
    trials: [],
    settings: {
      rounds: clampInt($("opt-rounds").value, 1, 50),
      gapMs: clampInt($("opt-gap").value, 200, 30000),
      groups: [...app.activeGroups],
      recordFailedOnly: !$("opt-record").checked,
    },
  };
}

function resumeOrCreate() {
  const existing = store.loadState(app.suite.id);
  if (existing && existing.trials && existing.trials.length) {
    // Continue the same session: the queue is rebuilt deterministically from
    // settings, so skip the trials already recorded.
    app.state = existing;
    app.state.thresholds = freshState().thresholds;
    app.state.device = deviceInfo();
    return existing;
  }
  app.state = freshState();
  return app.state;
}

async function start() {
  if (!app.suite) return;
  // Must happen synchronously inside the click handler, before any await.
  app.player.unlock();
  if (!app.sensor.status.audio && !app.sensor.status.video) {
    const ok = window.confirm(
      "麦克风和摄像头都不可用，将退化为纯人工判定（你听/看后按键）。继续吗？"
    );
    if (!ok) return;
  }

  resumeOrCreate();
  app.queue = buildQueue();
  const done = app.state.trials.length;
  app.cursor = Math.min(done, app.queue.length);
  app.running = true;
  app.paused = false;
  app.awaiting = null;

  showView("run");
  $("btn-restart").hidden = false;
  $("pill-store").textContent = `本地存储 ${store.usageKb()} KB`;
  requestPersistenceOnce();
  renderItems();
  updateProgress();
  await step();
}

async function requestPersistenceOnce() {
  if (requestPersistenceOnce._done) return;
  requestPersistenceOnce._done = true;
  const kept = await store.requestPersistence();
  if (!kept) {
    $("pill-store").className = "pill warn";
    $("pill-store").title = "浏览器可能在磁盘紧张时清掉本地数据，重要结果请及时导出";
  }
}

function updateProgress() {
  const total = app.queue.length;
  $("run-progress").textContent = `${Math.min(app.cursor, total)} / ${total}`;
}

async function step() {
  if (!app.running || app.paused) return;
  if (app.cursor >= app.queue.length) return finish();

  const { utt, round } = app.queue[app.cursor];
  const group = groupOf(app.suite, utt);
  const url = audioUrl(app.suite, utt);

  $("stage").classList.remove("awaiting");
  $("stage").classList.add("playing");
  $("verdicts").hidden = true;
  $("run-text").textContent = utt.text;
  $("run-sub").textContent = utt.translation || "";
  $("run-utt-id").textContent = `${utt.id} · 第 ${round} 轮`;
  $("run-group").textContent = group ? group.name : "未分组";
  updateProgress();
  highlightCurrent(utt.id);
  scrollToCurrent(utt.id);

  const windowMs = clampInt($("opt-window").value, 500, 30000);
  const settleMs = clampInt($("opt-settle").value, 0, 5000);
  const silenceMs = clampInt($("opt-silence").value, 200, 10000);
  const rmsPeakDb = Number($("opt-rms").value);
  const frameDiff = Number($("opt-motion").value);
  const rule = $("opt-rule").value;

  app.sensor.startWindow({ windowMs, settleMs, silenceMs, rmsPeakDb, frameDiff });

  const startedAt = new Date().toISOString();
  let playMs = 0;
  let playError = null;

  if (url) {
    try {
      playMs = await app.player.play(url);
    } catch (err) {
      playError = err.message;
      toast(`音频播放失败：${err.message}`, true);
    }
  } else {
    toast(`${utt.id} 没有音频，请人工念出这句`, true);
  }

  app.sensor.markPlaybackEnd();
  $("stage").classList.remove("playing");
  $("run-sub").textContent = "检测中…";

  // The sensor closes the window itself: either silenceMs of quiet after a hit,
  // or windowMs with nothing at all. Poll until it says so.
  const hardStop = performance.now() + settleMs + windowMs + 3000;
  while (app.running && !app.paused) {
    if (app.sensor.windowElapsed) break;
    if (performance.now() > hardStop) break;
    await sleep(80);
  }

  const reading = app.sensor.stopWindow();
  updateMeters(null);

  if (!app.running) return;

  const auto = playError
    ? { verdict: "skip", reason: `audio unavailable: ${playError}` }
    : classify(reading, { rule, minMotion: frameDiff });

  app.awaiting = { utt, round, reading, auto, startedAt, playMs };
  $("stage").classList.add("awaiting");
  $("run-sub").textContent = describeAuto(auto, reading);
  $("verdicts").hidden = false;
}

function describeAuto(auto, reading) {
  if (!reading) return "无法判定，请人工确认";
  const bits = [];
  if (reading.peakRmsDb !== null) bits.push(`音 ${reading.peakRmsDb.toFixed(0)} dB`);
  if (reading.frameDiff !== null) bits.push(`动 ${reading.frameDiff.toFixed(1)}`);
  const head = bits.join(" · ");
  const tail = auto.verdict === "pass" ? "检测到响应" : auto.verdict === "fail" ? "没检测到响应" : "信号不足";
  return `${head} → ${tail}（以下按键为准）`;
}

function onVerdict(human) {
  if (!app.awaiting) return;
  const { utt, round, reading, auto, startedAt } = app.awaiting;
  const trial = {
    utteranceId: utt.id,
    round,
    startedAt,
    metrics: {
      peakRmsDb: reading ? reading.peakRmsDb : null,
      baselineRmsDb: app.baselineDb,
      frameDiff: reading ? reading.frameDiff : null,
      latencyMs: reading ? reading.latencyMs : null,
    },
    sensorVerdict: auto.verdict,
    sensorReason: auto.reason,
    humanVerdict: human,
  };
  if (human !== "skip" && auto.verdict !== "skip") {
    trial.agreement = human === auto.verdict;
  }

  app.state.trials.push(trial);
  const saved = store.saveState(app.state.suiteId, app.state);
  if (!saved) toast("本地存储写满，请尽快导出结果", true);

  app.awaiting = null;
  $("verdicts").hidden = true;
  $("stage").classList.remove("awaiting");
  app.cursor += 1;
  renderItems();
  updateProgress();
  $("pill-store").textContent = `本地存储 ${store.usageKb()} KB`;

  if (!saved) return;

  const gap = clampInt($("opt-gap").value, 200, 30000);
  setTimeout(() => step(), gap);
}

async function replay() {
  if (!app.awaiting) return;
  const url = audioUrl(app.suite, app.awaiting.utt);
  if (!url) return;
  try {
    await app.player.play(url);
  } catch (err) {
    toast(err.message, true);
  }
}

// ------------------------------------------------------------------- render

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function resultFor(utteranceId) {
  const list = app.state ? app.state.trials.filter((t) => t.utteranceId === utteranceId) : [];
  if (!list.length) return { label: "待测", cls: "wait" };
  const pass = list.filter((t) => (t.humanVerdict || t.sensorVerdict) === "pass").length;
  const fail = list.filter((t) => (t.humanVerdict || t.sensorVerdict) === "fail").length;
  const inc = list.filter((t) => (t.humanVerdict || t.sensorVerdict) === "inconclusive").length;
  const done = pass + fail + inc;
  const rounds = app.state.settings.rounds;
  const rate = pass + fail === 0 ? null : pass / (pass + fail);
  const cls = rate === null ? (inc ? "inc" : "wait") : rate >= 0.8 ? "ok" : rate >= 0.5 ? "inc" : "no";
  return { label: `${pass}/${done}${done < rounds ? "…" : ""}`, cls };
}

function renderItems() {
  const box = $("run-items");
  if (!app.suite) return;
  const utts = selectUtterances(app.suite, new Set(app.state.settings.groups));
  box.replaceChildren();

  for (const u of utts) {
    const g = groupOf(app.suite, u);
    const r = resultFor(u.id);
    const el = document.createElement("div");
    el.className = "item";
    el.dataset.utt = u.id;
    el.innerHTML = `
      <span class="idx">${escapeHtml(g ? g.name : "")}</span>
      <span class="txt">${escapeHtml(u.text)}<span class="zh">${escapeHtml(u.translation || "")}</span></span>
      <span class="res"><span class="${r.cls}">${r.label}</span></span>`;
    box.appendChild(el);
  }
  highlightCurrent(app.awaiting ? app.awaiting.utt.id : null);
}

function highlightCurrent(uttId) {
  for (const el of document.querySelectorAll(".item")) {
    el.classList.toggle("current", el.dataset.utt === uttId);
  }
}

function scrollToCurrent(uttId) {
  const el = document.querySelector(`.item[data-utt="${CSS.escape(uttId)}"]`);
  if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

let meterTimer = null;
function startMeterLoop() {
  if (meterTimer) return;
  meterTimer = setInterval(() => {
    if (!app.sensor.status.audio && !app.sensor.status.video) return;
    updateMeters(app.sensor.levels);
  }, 120);
}

function updateMeters(levels) {
  const rmsThresh = Number($("opt-rms").value);
  const motionThresh = Number($("opt-motion").value);
  const rmsMark = Math.max(0, Math.min(100, ((rmsThresh + 80) / 70) * 100));
  const motionMark = Math.max(0, Math.min(100, (motionThresh / 30) * 100));
  const rmsBar = $("bar-rms");
  const motionBar = $("bar-motion");
  if (rmsBar.parentElement) rmsBar.parentElement.style.setProperty("--thresh", `${rmsMark}%`);
  if (motionBar.parentElement) motionBar.parentElement.style.setProperty("--thresh", `${motionMark}%`);

  if (levels) {
    const rms = levels.rmsDb;
    $("m-rms").textContent = `${rms.toFixed(0)} dB`;
    rmsBar.style.width = `${Math.max(0, Math.min(100, ((rms + 80) / 70) * 100))}%`;
    rmsBar.style.background = rms > rmsThresh ? "var(--accent)" : "var(--dim)";
    const motion = levels.frameDiff;
    $("m-motion").textContent = motion.toFixed(1);
    motionBar.style.width = `${Math.max(0, Math.min(100, (motion / 30) * 100))}%`;
    motionBar.style.background = motion > motionThresh ? "var(--accent)" : "var(--blue)";
  } else {
    $("m-rms").textContent = "—";
    $("m-motion").textContent = "—";
    rmsBar.style.width = "0%";
    motionBar.style.width = "0%";
  }
}

// ------------------------------------------------------------------ results

function renderResults() {
  const s = app.state;
  if (!s || !s.trials.length) {
    $("rank-summary").textContent = "还没有数据。先跑一轮测试。";
    $("kpis").replaceChildren();
    $("table-groups").querySelector("tbody").replaceChildren();
    $("table-utterances").querySelector("tbody").replaceChildren();
    $("tag-weakness").replaceChildren();
    return;
  }

  const summary = stats.summarize(s.trials, app.suite.utterances);
  const rate = stats.pct(summary.passRate);

  $("rank-summary").textContent =
    `${app.suite.title} · ${summary.totalTrials} 轮 · ${s.sessionId.slice(0, 16).replace("T", " ")}`;

  const kpis = [
    { v: rate, k: "成功率（不含不确定）" },
    { v: summary.pass, k: "成功" },
    { v: summary.fail, k: "失败" },
    { v: summary.inconclusive, k: "不确定（环境干扰）" },
    { v: summary.sensorHumanAgreement === null ? "—" : stats.pct(summary.sensorHumanAgreement), k: "传感器与人一致" },
  ];
  $("kpis").replaceChildren(...kpis.map(({ v, k }) => {
    const el = document.createElement("div");
    el.className = "kpi";
    el.innerHTML = `<div class="v">${escapeHtml(v)}</div><div class="k">${escapeHtml(k)}</div>`;
    return el;
  }));

  const gBody = $("table-groups").querySelector("tbody");
  gBody.replaceChildren(...app.suite.groups.map((g) => {
    const b = summary.byGroup[g.id];
    if (!b) return document.createElement("tr");
    const tr = document.createElement("tr");
    const r = stats.passRate(b);
    tr.innerHTML = `
      <td>${escapeHtml(g.name)}</td>
      <td class="num">${b.trials}</td>
      <td class="num">${b.pass}</td>
      <td class="num">${b.fail}</td>
      <td class="num">${b.inconclusive}</td>
      <td class="num"><span class="rate ${rateClass(r)}">${stats.pct(r)}</span></td>`;
    return tr;
  }));

  const ranked = stats.rankUtterances(summary, app.suite.utterances);
  const uBody = $("table-utterances").querySelector("tbody");
  uBody.replaceChildren(...ranked.map((row, i) => {
    const g = app.suite.groups.find((x) => x.id === row.groupId);
    const tr = document.createElement("tr");
    if (i < 3 && row.rate !== null) tr.className = `rank-${i + 1}`;
    tr.innerHTML = `
      <td class="num">${i + 1}</td>
      <td>${escapeHtml(row.text)}<div style="color:var(--muted);font-size:12px">${escapeHtml(row.translation)}</div></td>
      <td>${escapeHtml(g ? g.name : "")}</td>
      <td class="num">${row.trials}</td>
      <td class="num">${row.pass}</td>
      <td class="num">${row.fail}</td>
      <td class="num"><span class="rate ${rateClass(row.rate)}">${stats.pct(row.rate)}</span></td>
      <td class="num">${row.medianLatencyMs === null ? "—" : `${row.medianLatencyMs} ms`}</td>`;
    return tr;
  }));

  const weak = stats.weakestTags(summary, 2).slice(0, 12);
  const box = $("tag-weakness");
  if (!weak.length) {
    box.innerHTML = `<div class="empty">样本太少，还看不出特征规律。</div>`;
  } else {
    box.innerHTML = weak.map((t) => `
      <div class="row" style="justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line)">
        <span><span class="tag">${escapeHtml(t.tag)}</span></span>
        <span style="display:flex;gap:14px;align-items:center">
          <span style="color:var(--muted);font-size:12.5px">${t.pass}/${t.pass + t.fail}</span>
          <span class="rate ${rateClass(t.rate)}">${stats.pct(t.rate)}</span>
        </span>
      </div>`).join("");
  }
}

function rateClass(r) {
  if (r === null || r === undefined) return "";
  if (r >= 0.8) return "high";
  if (r >= 0.5) return "mid";
  return "low";
}

// ------------------------------------------------------------------- export

function currentSessionDoc() {
  const s = app.state;
  const summary = stats.summarize(s.trials, app.suite.utterances);
  const doc = {
    schemaVersion: "1.0",
    suiteId: s.suiteId,
    sessionId: s.sessionId,
    startedAt: s.startedAt,
    endedAt: new Date().toISOString(),
    device: s.device,
    thresholds: s.thresholds,
    trials: s.trials,
    summary: {
      totalTrials: summary.totalTrials,
      passRate: summary.passRate === null ? 0 : round3(summary.passRate),
      sensorHumanAgreement: summary.sensorHumanAgreement === null ? 0 : round3(summary.sensorHumanAgreement),
      byGroup: Object.fromEntries(Object.entries(summary.byGroup).map(([k, b]) => [k, slimBucket(b)])),
      byTag: Object.fromEntries(Object.entries(summary.byTag).map(([k, b]) => [k, slimBucket(b)])),
      byUtterance: Object.fromEntries(Object.entries(summary.byUtterance).map(([k, b]) => [k, {
        ...slimBucket(b),
        ...(b.medianLatencyMs == null ? {} : { medianLatencyMs: b.medianLatencyMs }),
      }])),
    },
  };
  return doc;
}

function slimBucket(b) {
  return {
    trials: b.trials,
    pass: b.pass,
    fail: b.fail,
    ...(b.inconclusive ? { inconclusive: b.inconclusive } : {}),
    passRate: b.pass + b.fail === 0 ? 0 : round3(b.pass / (b.pass + b.fail)),
  };
}

const round3 = (x) => Math.round(x * 1000) / 1000;

function exportSession() {
  if (!app.state || !app.state.trials.length) return toast("还没有数据", true);
  const slug = store.timestampSlug();
  store.downloadJson(`saycheck-${app.state.suiteId}-${slug}.session.json`, currentSessionDoc());
  toast("已导出测试记录 JSON");
}

function exportTrials() {
  if (!app.state || !app.state.trials.length) return toast("还没有数据", true);
  const csv = stats.trialsCsv(currentSessionDoc(), app.suite.utterances);
  store.downloadCsv(`saycheck-${app.state.suiteId}-${store.timestampSlug()}-trials.csv`, csv);
  toast("已导出逐轮 CSV");
}

function exportRanking() {
  if (!app.state || !app.state.trials.length) return toast("还没有数据", true);
  const summary = stats.summarize(app.state.trials, app.suite.utterances);
  const csv = stats.rankingCsv(summary, app.suite.utterances);
  store.downloadCsv(`saycheck-${app.state.suiteId}-${store.timestampSlug()}-ranking.csv`, csv);
  toast("已导出排行 CSV");
}

// -------------------------------------------------------------------- finish

function finish() {
  app.running = false;
  app.paused = false;
  app.sensor.stopWindow();
  app.awaiting = null;
  $("verdicts").hidden = true;
  $("stage").classList.remove("awaiting", "playing");
  renderResults();
  showView("rank");
  $("pill-store").textContent = `本地存储 ${store.usageKb()} KB`;
}

function togglePause() {
  if (!app.running) return;
  app.paused = !app.paused;
  $("btn-pause").textContent = app.paused ? "继续" : "暂停";
  if (app.paused) {
    $("run-sub").textContent = "已暂停";
  } else if (!app.awaiting) {
    step();
  }
}

// --------------------------------------------------------------------- wiring

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function bind() {
  $("btn-load-suite").onclick = () => loadSuiteIntoApp($("suite-url").value.trim());

  $("btn-pick-file").onclick = () => $("file-input").click();
  $("file-input").onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await loadSuiteIntoApp(file);
  };

  $("btn-check-devices").onclick = checkDevices;
  $("btn-calibrate").onclick = calibrate;
  $("btn-start").onclick = start;

  $("btn-pass").onclick = () => onVerdict("pass");
  $("btn-fail").onclick = () => onVerdict("fail");
  $("btn-replay").onclick = replay;
  $("btn-pause").onclick = togglePause;
  $("btn-finish").onclick = finish;

  $("btn-export-session").onclick = exportSession;
  $("btn-export-trials").onclick = exportTrials;
  $("btn-export-ranking").onclick = exportRanking;

  $("btn-clear").onclick = () => {
    if (!app.suite) return;
    if (!window.confirm("清空这套题在本机的全部测试记录？导出的文件不受影响。")) return;
    store.clearState(app.suite.id);
    app.state = null;
    $("btn-clear").hidden = true;
    toast("已清空本机记录");
  };

  $("btn-restart").onclick = () => {
    app.running = false;
    app.paused = false;
    app.awaiting = null;
    app.sensor.stopWindow();
    showView("setup");
    $("btn-restart").hidden = true;
  };

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    const k = e.key.toLowerCase();
    if (app.awaiting && (k === "y" || k === "1")) { e.preventDefault(); onVerdict("pass"); }
    else if (app.awaiting && (k === "n" || k === "2")) { e.preventDefault(); onVerdict("fail"); }
    else if (app.awaiting && (k === "r" || k === "3")) { e.preventDefault(); replay(); }
    else if (k === " ") { e.preventDefault(); togglePause(); }
  });

  window.addEventListener("beforeunload", (e) => {
    if (app.running && !app.awaiting) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

async function boot() {
  bind();
  startMeterLoop();
  $("pill-store").textContent = `本地存储 ${store.usageKb()} KB`;

  const params = new URLSearchParams(location.search);
  const suiteParam = params.get("suite");
  if (suiteParam) $("suite-url").value = suiteParam;
  const apiParam = params.get("api");
  if (apiParam) window.__SAYCHECK_API__ = apiParam;

  const ok = await loadSuiteIntoApp($("suite-url").value.trim());
  if (ok && params.get("autostart") === "1") {
    await checkDevices();
    await calibrate();
    await start();
  }
}

boot();
