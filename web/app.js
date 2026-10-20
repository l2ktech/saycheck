// SayCheck single-page runner.
// Everything lives on one screen: stage, controls, group filter, podium, tables.
// Plain DOM, no framework, no build step.

import { loadSuite, loadSuiteFromFile, audioUrl, wakeUrl, selectUtterances, groupOf } from "./core/suite.js";
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
  awaiting: null,
  baselineDb: null,
  activeGroups: new Set(),
  phase: "idle", // idle | playing | sensing | awaiting
};

// ------------------------------------------------------------------ helpers

function toast(msg, bad = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("bad", bad);
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), bad ? 4200 : 2200);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clampInt = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};

function deviceInfo() {
  return {
    ua: navigator.userAgent,
    platform: navigator.platform || "",
    mic: app.sensor.status.audio ? "default input" : "",
    camera: app.sensor.status.video ? "default camera" : "",
    screen: `${window.screen.width}x${window.screen.height}@${window.devicePixelRatio || 1}`,
  };
}

// -------------------------------------------------------------------- suite

async function loadSuiteIntoApp(source) {
  try {
    const suite = typeof source === "string" ? await loadSuite(source) : await loadSuiteFromFile(source);
    app.suite = suite;
    app.activeGroups = new Set(suite.groups.map((g) => g.id));

    $("pill-suite").textContent = `${suite.id} · ${suite.utterances.length} 条`;
    $("pill-suite").className = "pill ok";
    $("pill-suite").title = suite.title;

    applyDefaults(suite.defaults);

    const existing = store.loadState(suite.id);
    if (existing) {
      app.state = existing;
      $("restore-note").textContent = `已从本机恢复 ${existing.trials.length} 轮记录`;
    } else {
      app.state = null;
      $("restore-note").textContent = `套件已加载 · ${suite.groups.length} 组 ${suite.utterances.length} 条`;
    }

    renderAll();

    const urls = suite.utterances.map((u) => audioUrl(suite, u)).filter(Boolean);
    const wu = wakeUrl(suite);
    if (wu) urls.unshift(wu); // wake clip first: it repeats every round
    app.player.preload(urls.slice(0, 24), 4).then(() => {
      if (urls.length > 24) app.player.preload(urls.slice(24), 2);
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
  $("opt-judge").value = d.judgeMode || "manual";
  $("opt-record").checked = !d.recordFailedOnly;

  // The wake control only appears when the suite actually ships a wake clip.
  const hasWake = !!(app.suite && app.suite.wake && app.suite.wake.audio);
  $("wake-field").hidden = !hasWake;
  $("opt-wake").checked = hasWake && d.useWake !== false;
  if (hasWake && app.suite.wake.label) {
    $("wake-label").textContent = `每轮先播「${app.suite.wake.label}」`;
  }
}

// ------------------------------------------------------------------- device

async function checkDevices() {
  const st = await app.sensor.init({ audio: true, video: true });
  const p = $("pill-sensors");
  if (st.audio && st.video) { p.textContent = "麦克风 ✓ 摄像头 ✓"; p.className = "pill ok"; }
  else if (st.audio) { p.textContent = "仅麦克风"; p.className = "pill warn"; }
  else if (st.video) { p.textContent = "仅摄像头"; p.className = "pill warn"; }
  else { p.textContent = "纯人工判定"; p.className = "pill bad"; }
  if (st.reason) toast(st.reason, !st.audio && !st.video);
  $("footer-hint").textContent = st.audio || st.video
    ? "判定 = 麦克风 RMS + 摄像头帧差 + 人工一键"
    : "传感器不可用，当前为纯人工判定";
}

async function calibrate() {
  if (!app.sensor.canSenseAudio) { toast("麦克风不可用，无法校准", true); return; }
  $("cal-hint").textContent = "采样中，请保持安静…";
  const db = await app.sensor.calibrate(1500);
  if (db === null) { $("cal-hint").textContent = "采样失败"; return; }
  app.baselineDb = db;
  const suggested = Math.round(Math.min(-18, Math.max(-70, db + 18)));
  $("opt-rms").value = suggested;
  $("cal-hint").textContent = `底噪 ${db.toFixed(1)} dB → 建议 ${suggested} dB（已填入）`;
  updateMeterMarks();
}

// --------------------------------------------------------------------- state

function newState() {
  return {
    suiteId: app.suite.id,
    suiteTitle: app.suite.title,
    sessionId: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    thresholds: currentThresholds(),
    device: deviceInfo(),
    trials: [],
    settings: currentSettings(),
  };
}

function currentThresholds() {
  return {
    rmsBaselineDb: app.baselineDb,
    rmsPeakDb: Number($("opt-rms").value),
    frameDiff: Number($("opt-motion").value),
    windowMs: clampInt($("opt-window").value, 500, 30000),
    settleMs: clampInt($("opt-settle").value, 0, 5000),
    silenceMs: clampInt($("opt-silence").value, 200, 10000),
    rule: $("opt-rule").value,
  };
}

function currentSettings() {
  return {
    rounds: clampInt($("opt-rounds").value, 1, 50),
    gapMs: clampInt($("opt-gap").value, 0, 30000),
    groups: [...app.activeGroups],
    judgeMode: $("opt-judge").value,
    useWake: !!$("opt-wake").checked,
    recordFailedOnly: !$("opt-record").checked,
  };
}

function ensureState() {
  if (!app.state || app.state.suiteId !== app.suite.id) {
    app.state = newState();
    return app.state;
  }
  app.state.thresholds = currentThresholds();
  app.state.settings = currentSettings();
  app.state.device = deviceInfo();
  return app.state;
}

function persist() {
  if (!app.state) return true;
  const ok = store.saveState(app.state.suiteId, app.state);
  if (!ok) toast("本地存储写满，请尽快导出结果", true);
  $("pill-store").textContent = `已入库 ${app.state.trials.length} 轮`;
  return ok;
}

// ---------------------------------------------------------------------- run

function buildQueue(onlyGroupId = null, onlyUttId = null) {
  let utts = selectUtterances(app.suite, app.activeGroups);
  if (onlyGroupId) utts = app.suite.utterances.filter((u) => u.groupId === onlyGroupId);
  if (onlyUttId) utts = app.suite.utterances.filter((u) => u.id === onlyUttId);
  const rounds = clampInt($("opt-rounds").value, 1, 50);
  const q = [];
  for (const u of utts) for (let r = 1; r <= rounds; r += 1) q.push({ utt: u, round: r });
  return q;
}

/** Skip rounds already present in the store, so "开始" resumes instead of repeating. */
function remainingQueue(queue) {
  const done = new Set((app.state?.trials || []).map((t) => `${t.utteranceId}#${t.round}`));
  return queue.filter((item) => !done.has(`${item.utt.id}#${item.round}`));
}

async function start(opts = {}) {
  if (!app.suite) { toast("先加载套件", true); return; }
  app.player.unlock(); // must run synchronously inside the click

  if (!app.sensor.status.audio && !app.sensor.status.video && !start._warned) {
    start._warned = true;
    toast("麦克风和摄像头都没授权，将退化为纯人工判定", true);
  }

  ensureState();
  app.state.settings = currentSettings();

  const full = buildQueue(opts.groupId || null, opts.uttId || null);
  const todo = opts.fresh ? full : remainingQueue(full);
  if (!todo.length) {
    toast("这些词已经跑完了。加大轮数，或先清空记录。", true);
    return;
  }

  app.queue = todo;
  app.cursor = 0;
  app.running = true;
  app.awaiting = null;
  $("btn-start").textContent = "▶ 继续";
  $("btn-stop").disabled = false;

  renderAll();
  await step();
}

function stop() {
  app.running = false;
  app.awaiting = null;
  app.phase = "idle";
  app.sensor.stopWindow();
  app.player.stop();
  setPhase("idle", "已停", "点「继续」接着跑");
  $("btn-stop").disabled = true;
  $("btn-start").textContent = "▶ 继续";
  renderAll();
}

function setPhase(phase, flag, sub) {
  app.phase = phase;
  const stage = $("stage");
  stage.classList.toggle("playing", phase === "playing" || phase === "sensing");
  stage.classList.toggle("awaiting", phase === "awaiting");
  if (flag !== undefined) $("run-flag").textContent = flag;
  if (sub !== undefined) $("run-sub").textContent = sub;
  const awaiting = phase === "awaiting";
  $("actions-idle").hidden = awaiting;
  $("actions-verdict").hidden = !awaiting;
}

async function step() {
  if (!app.running) return;
  if (app.cursor >= app.queue.length) return finish();

  const { utt, round } = app.queue[app.cursor];
  const group = groupOf(app.suite, utt);
  const url = audioUrl(app.suite, utt);

  $("run-text").textContent = utt.text;
  $("run-utt-id").textContent = `${utt.id} · 第 ${round} 轮`;
  highlightRow(utt.id);

  const t = currentThresholds();
  const judgeMode = $("opt-judge").value;
  const sub = group ? `${group.name} · ${utt.translation || ""}` : utt.translation || "";

  // The wake phrase goes first and stays OUTSIDE the measuring window: its own
  // audio must never be mistaken for the robot's reply.
  if (app.suite.wake && $("opt-wake").checked) {
    const wu = wakeUrl(app.suite);
    if (wu) {
      const label = app.suite.wake.label ? `「${app.suite.wake.label}」` : "";
      setPhase("playing", "唤醒", `先播唤醒音${label}…`);
      try {
        await app.player.play(wu);
      } catch (err) {
        toast(`唤醒音播放失败：${err.message}`, true);
      }
      await sleep(app.suite.wake.settleMs ?? 900);
      if (!app.running) return;
    }
  }

  setPhase("playing", "播放", sub);
  app.sensor.startWindow({
    windowMs: t.windowMs, settleMs: t.settleMs, silenceMs: t.silenceMs,
    rmsPeakDb: t.rmsPeakDb, frameDiff: t.frameDiff,
  });

  const startedAt = new Date().toISOString();
  let playError = null;
  if (url) {
    try { await app.player.play(url); }
    catch (err) { playError = err.message; toast(`播放失败：${err.message}`, true); }
  } else {
    playError = "no audio";
    toast(`${utt.id} 没有音频，请人工念出这句`, true);
  }

  app.sensor.markPlaybackEnd();
  setPhase("sensing", "检测", "听着 / 看着…");

  const hardStop = performance.now() + t.settleMs + t.windowMs + 3000;
  while (app.running) {
    if (app.sensor.windowElapsed) break;
    if (performance.now() > hardStop) break;
    await sleep(80);
  }

  const reading = app.sensor.stopWindow();
  resetMeters();
  if (!app.running) return;

  const auto = playError
    ? { verdict: "skip", reason: `audio unavailable: ${playError}` }
    : classify(reading, { rule: t.rule, minMotion: t.frameDiff });

  if (judgeMode === "auto") {
    // Unattended batch: trust the sensor and keep going. An inconclusive reading
    // becomes skip, so a noisy room never silently counts as a failure.
    setPhase("sensing", "自动判定", describeAuto(auto, reading));
    await sleep(450);
    commitTrial(utt, round, reading, auto, startedAt,
      auto.verdict === "inconclusive" ? "skip" : auto.verdict);
    setTimeout(() => step(), clampInt($("opt-gap").value, 0, 30000));
    return;
  }

  app.awaiting = { utt, round, reading, auto, startedAt };
  setPhase("awaiting", "待判定", describeAuto(auto, reading));
  $("btn-pass").focus({ preventScroll: true });
}

function describeAuto(auto, reading) {
  if (!reading) return "无法判定，请人工确认";
  const bits = [];
  if (reading.peakRmsDb !== null) bits.push(`音 ${reading.peakRmsDb.toFixed(0)} dB`);
  if (reading.frameDiff !== null) bits.push(`动 ${reading.frameDiff.toFixed(1)}`);
  const tail = auto.verdict === "pass" ? "检测到响应" : auto.verdict === "fail" ? "没检测到响应" : "信号不足";
  return `${bits.join(" · ")} → ${tail}（以你的判断为准）`;
}

/** Append one trial, persist, and advance the cursor. Shared by manual and auto modes. */
function commitTrial(utt, round, reading, auto, startedAt, human) {
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
  if (human !== "skip" && auto.verdict !== "skip") trial.agreement = human === auto.verdict;

  app.state.trials.push(trial);
  persist();
  app.cursor += 1;
  renderAll();
}

function onVerdict(human) {
  if (!app.awaiting) return;
  const { utt, round, reading, auto, startedAt } = app.awaiting;
  app.awaiting = null;
  commitTrial(utt, round, reading, auto, startedAt, human);
  setTimeout(() => step(), clampInt($("opt-gap").value, 0, 30000));
}

async function replay() {
  if (!app.awaiting) return;
  const url = audioUrl(app.suite, app.awaiting.utt);
  if (!url) return;
  try { await app.player.play(url); } catch (err) { toast(err.message, true); }
}

function finish() {
  app.running = false;
  app.phase = "idle";
  app.awaiting = null;
  app.sensor.stopWindow();
  $("btn-start").textContent = "▶ 重新开始";
  $("btn-stop").disabled = true;
  setPhase("idle", "完成", "全部跑完，看下面的排行");
  $("run-text").textContent = "跑完了";
  if (app.state && app.state.trials.length) {
    store.pushSnapshot(app.state.suiteId, snapshotFromState());
  }
  renderAll();
}

/** Freeze this session's per-utterance rates so the next run can compare. */
function snapshotFromState() {
  const s = app.state;
  const summary = stats.summarize(s.trials, app.suite.utterances);
  const byUtterance = {};
  for (const [id, b] of Object.entries(summary.byUtterance)) {
    const decided = b.pass + b.fail;
    byUtterance[id] = { pass: b.pass, fail: b.fail, rate: decided ? b.pass / decided : null };
  }
  return { sessionId: s.sessionId, at: new Date().toISOString(), byUtterance };
}

// ------------------------------------------------------------------ render

function renderAll() {
  renderGroups();
  renderTables();
  renderPodium();
  renderToolbar();
  updateMeterMarks();
}

function renderGroups() {
  const box = $("group-chips");
  box.replaceChildren();
  if (!app.suite) return;
  for (const g of app.suite.groups) {
    const n = app.suite.utterances.filter((u) => u.groupId === g.id).length;
    const on = app.activeGroups.has(g.id);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "group-chip" + (on ? " on" : "");
    b.innerHTML = `<span>${on ? "☑" : "☐"}</span>${esc(g.name)}<span class="n">${n}</span>`;
    b.onclick = () => {
      if (app.activeGroups.has(g.id)) app.activeGroups.delete(g.id);
      else app.activeGroups.add(g.id);
      renderGroups();
      renderTables();
      renderToolbar();
    };
    box.appendChild(b);
  }
}

/** Per-utterance aggregate for one group, recomputed from trials each render. */
function uttStats(utteranceId) {
  const list = (app.state?.trials || []).filter((t) => t.utteranceId === utteranceId);
  const rounds = clampInt($("opt-rounds").value, 1, 50);
  const pass = list.filter((t) => (t.humanVerdict || t.sensorVerdict) === "pass").length;
  const fail = list.filter((t) => (t.humanVerdict || t.sensorVerdict) === "fail").length;
  const inc = list.filter((t) => (t.humanVerdict || t.sensorVerdict) === "inconclusive").length;
  const rate = pass + fail === 0 ? null : pass / (pass + fail);

  const lat = list.map((t) => t.metrics?.latencyMs).filter((x) => typeof x === "number");
  const avgLat = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length / 1000 : null;

  const peak = list.map((t) => t.metrics?.peakRmsDb).filter((x) => typeof x === "number");
  const avgPeak = peak.length ? peak.reduce((a, b) => a + b, 0) / peak.length : null;

  const mot = list.map((t) => t.metrics?.frameDiff).filter((x) => typeof x === "number");
  const avgMot = mot.length ? mot.reduce((a, b) => a + b, 0) / mot.length : null;

  return { list, rounds, pass, fail, inc, rate, avgLat, avgPeak, avgMot, trials: list.length };
}

function rateClass(r) {
  if (r === null || r === undefined) return "wait";
  if (r >= 0.8) return "high";
  if (r >= 0.5) return "mid";
  return "low";
}

function pct(r) { return r === null || r === undefined ? "—" : `${Math.round(r * 100)}%`; }

function renderTables() {
  const box = $("tables");
  if (!app.suite) {
    box.innerHTML = `<div class="empty">加载套件后，这里会按组列出每一条语句的成功率。</div>`;
    return;
  }

  const groups = app.suite.groups.filter((g) => app.activeGroups.has(g.id));
  if (!groups.length) {
    box.innerHTML = `<div class="empty">上面至少勾选一个组。</div>`;
    return;
  }

  // Compare against the previous finished run of this suite, if there is one.
  const prev = app.state ? store.previousSnapshot(app.suite.id, app.state.sessionId) : null;
  const prevBy = (prev && prev.byUtterance) || null;

  const frag = document.createDocumentFragment();

  groups.forEach((g, gi) => {
    const utts = app.suite.utterances.filter((u) => u.groupId === g.id);
    const rows = utts.map((u) => ({ u, s: uttStats(u.id) }));

    const totalPass = rows.reduce((a, r) => a + r.s.pass, 0);
    const totalTrials = rows.reduce((a, r) => a + r.s.pass + r.s.fail, 0);
    const ran = rows.filter((r) => r.s.trials > 0).length;
    const gRate = totalTrials === 0 ? null : totalPass / totalTrials;

    // Rank by rate desc; untested at the bottom.
    const ranked = [...rows].sort((a, b) => {
      if (a.s.rate === null && b.s.rate === null) return a.u.id.localeCompare(b.u.id);
      if (a.s.rate === null) return 1;
      if (b.s.rate === null) return -1;
      return b.s.rate - a.s.rate;
    });

    const block = document.createElement("div");
    block.className = "group-block";
    block.innerHTML = `
      <div class="group-head">
        <span class="group-num">${String(gi + 1).padStart(2, "0")}</span>
        <span class="group-name">${esc(g.name)}</span>
        <span class="group-scene">${esc(g.scene || "")}</span>
        <div class="group-stats">
          <span>已测 <b>${ran}/${utts.length}</b></span>
          <span>命中 <b>${totalPass}/${totalTrials}</b></span>
          <span>成功率 <b class="rate ${rateClass(gRate)}">${pct(gRate)}</b></span>
          <button class="small ghost" data-run-group="${g.id}">跑这组</button>
        </div>
      </div>
      <table>
        <thead><tr>
          <th>组内</th><th>唤醒词</th><th class="num">成功/轮</th><th class="num">成功率</th>
          <th class="num" title="上一次跑完时的成功率与变化">上次</th>
          <th></th><th>各轮</th><th class="num">音 dB</th><th class="num">动</th>
          <th class="num">延迟</th><th></th>
        </tr></thead>
        <tbody></tbody>
      </table>`;

    const tbody = block.querySelector("tbody");
    ranked.forEach(({ u, s }, i) => {
      const rank = s.rate === null ? "—" : `第${i + 1}`;
      const tr = document.createElement("tr");
      tr.dataset.utt = u.id;
      if (s.rate !== null && i === 0) tr.className = "top1";

      const roundsHtml = Array.from({ length: s.rounds }, (_, k) => {
        const trial = s.list.find((t) => t.round === k + 1);
        if (!trial) return `<span class="round" title="第${k + 1}轮 · 未跑">${k + 1}</span>`;
        const v = trial.humanVerdict || trial.sensorVerdict;
        const cls = v === "pass" ? "pass" : v === "fail" ? "fail" : v === "skip" ? "skip" : "inc";
        const mark = v === "pass" ? "✓" : v === "fail" ? "×" : "·";
        const tip = [
          `第${k + 1}轮`,
          `人工 ${trial.humanVerdict || "—"} / 传感器 ${trial.sensorVerdict}`,
          trial.metrics?.peakRmsDb != null ? `音 ${trial.metrics.peakRmsDb} dB` : "",
          trial.metrics?.frameDiff != null ? `动 ${trial.metrics.frameDiff}` : "",
          trial.metrics?.latencyMs != null ? `延迟 ${trial.metrics.latencyMs} ms` : "",
        ].filter(Boolean).join(" · ");
        return `<span class="round ${cls}" title="${esc(tip)}">${mark}</span>`;
      }).join("");

      const rateCls = rateClass(s.rate);
      const barCls = rateCls === "high" ? "" : rateCls === "mid" ? "mid" : rateCls === "low" ? "low" : "";
      const fill = s.rate === null ? 0 : Math.round(s.rate * 100);

      const p = prevBy ? prevBy[u.id] : null;
      const delta = p && p.rate !== null && s.rate !== null ? s.rate - p.rate : null;
      const deltaPct = delta === null ? 0 : Math.round(delta * 100);
      const deltaHtml = delta === null || Math.abs(deltaPct) < 1
        ? ""
        : `<span class="delta ${delta > 0 ? "up" : "down"}">${delta > 0 ? "▲" : "▼"}${Math.abs(deltaPct)}</span>`;

      tr.innerHTML = `
        <td class="rank">${rank}</td>
        <td class="text-cell"><div class="t" title="${esc(u.text)}">${esc(u.text)}</div><div class="zh">${esc(u.translation || "")}</div></td>
        <td class="num">${s.pass}/${s.pass + s.fail}</td>
        <td class="num"><span class="rate ${rateCls}">${pct(s.rate)}</span></td>
        <td class="num"><span class="prev">${p ? pct(p.rate) : "—"}</span>${deltaHtml}</td>
        <td><span class="mini-progress ${barCls}"><i style="width:${fill}%"></i></span></td>
        <td><div class="rounds">${roundsHtml}</div></td>
        <td class="num"><span class="sig">${s.avgPeak === null ? "—" : `<b>${s.avgPeak.toFixed(0)}</b>`}</span></td>
        <td class="num"><span class="sig">${s.avgMot === null ? "—" : `<b>${s.avgMot.toFixed(1)}</b>`}</span></td>
        <td class="num">${s.avgLat === null ? "—" : `${s.avgLat.toFixed(2)}s`}</td>
        <td><button class="small ghost" data-run-utt="${u.id}">跑这个词</button></td>`;
      tbody.appendChild(tr);
    });

    frag.appendChild(block);
  });

  box.replaceChildren(frag);

  box.querySelectorAll("[data-run-group]").forEach((b) => {
    b.onclick = () => start({ groupId: b.dataset.runGroup, fresh: false });
  });
  box.querySelectorAll("[data-run-utt]").forEach((b) => {
    b.onclick = () => start({ uttId: b.dataset.runUtt, fresh: false });
  });
  if (app.awaiting) highlightRow(app.awaiting.utt.id);
}

function highlightRow(uttId) {
  for (const tr of document.querySelectorAll("#tables tbody tr")) {
    tr.classList.toggle("current", tr.dataset.utt === uttId);
  }
  const el = document.querySelector(`#tables tr[data-utt="${CSS.escape(uttId)}"]`);
  if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderPodium() {
  const box = $("podium");
  if (!app.suite || !app.state || !app.state.trials.length) { box.replaceChildren(); return; }

  const all = app.suite.utterances
    .map((u) => ({ u, s: uttStats(u.id) }))
    .filter((x) => x.s.rate !== null && x.s.pass + x.s.fail > 0)
    .sort((a, b) => b.s.rate - a.s.rate || (a.s.avgLat ?? 9) - (b.s.avgLat ?? 9))
    .slice(0, 3);

  if (!all.length) { box.replaceChildren(); return; }

  const medals = ["🏆", "🥈", "🥉"];
  const names = ["第一名", "第二名", "第三名"];
  box.innerHTML = all.map(({ u, s }, i) => {
    const g = groupOf(app.suite, u);
    return `
      <div class="podium-card g${i + 1}">
        <div class="podium-head">
          <span class="medal">${medals[i]}</span>${names[i]}
          <span class="podium-group">${esc(g ? g.name : "")}</span>
        </div>
        <div class="podium-text">${esc(u.text)}</div>
        <div class="podium-zh">${esc(u.translation || "")}</div>
        <div class="podium-rate">${pct(s.rate)}</div>
        <div class="podium-meta">命中 ${s.pass}/${s.pass + s.fail} · 平均响应 ${s.avgLat === null ? "—" : s.avgLat.toFixed(2) + "s"}</div>
      </div>`;
  }).join("");
}

function renderToolbar() {
  const total = app.suite ? selectUtterances(app.suite, app.activeGroups).length * clampInt($("opt-rounds").value, 1, 50) : 0;
  const done = app.state ? app.state.trials.length : 0;
  const p = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  $("progress-fill").style.width = `${p}%`;
  $("progress-text").textContent = `进度 ${done}/${total} 轮 (${p}%)`;
  $("pill-store").textContent = `已入库 ${done} 轮`;
}

function updateMeterMarks() {
  const rmsThresh = Number($("opt-rms").value);
  const motionThresh = Number($("opt-motion").value);
  const rmsMark = Math.max(0, Math.min(100, ((rmsThresh + 80) / 70) * 100));
  const motionMark = Math.max(0, Math.min(100, (motionThresh / 30) * 100));
  const a = $("bar-rms")?.parentElement;
  const b = $("bar-motion")?.parentElement;
  if (a) a.style.setProperty("--thresh", `${rmsMark}%`);
  if (b) b.style.setProperty("--thresh", `${motionMark}%`);
}

let meterTimer = null;
function startMeterLoop() {
  if (meterTimer) return;
  meterTimer = setInterval(() => {
    if (!app.sensor.status.audio && !app.sensor.status.video) return;
    const { rmsDb, frameDiff } = app.sensor.levels;
    const rmsThresh = Number($("opt-rms").value);
    const motionThresh = Number($("opt-motion").value);

    $("m-rms").textContent = `${rmsDb.toFixed(0)}`;
    const rb = $("bar-rms");
    rb.style.width = `${Math.max(0, Math.min(100, ((rmsDb + 80) / 70) * 100))}%`;
    rb.style.background = rmsDb > rmsThresh ? "var(--accent)" : "var(--dim)";

    $("m-motion").textContent = frameDiff.toFixed(1);
    const mb = $("bar-motion");
    mb.style.width = `${Math.max(0, Math.min(100, (frameDiff / 30) * 100))}%`;
    mb.style.background = frameDiff > motionThresh ? "var(--accent)" : "var(--blue)";
  }, 120);
}

function resetMeters() {
  $("m-rms").textContent = "—";
  $("m-motion").textContent = "—";
  $("bar-rms").style.width = "0%";
  $("bar-motion").style.width = "0%";
}

// ------------------------------------------------------------------- export

function sessionDoc() {
  const s = app.state;
  const summary = stats.summarize(s.trials, app.suite.utterances);
  const slim = (b) => ({
    trials: b.trials, pass: b.pass, fail: b.fail,
    ...(b.inconclusive ? { inconclusive: b.inconclusive } : {}),
    passRate: b.pass + b.fail === 0 ? 0 : Math.round((b.pass / (b.pass + b.fail)) * 1000) / 1000,
  });
  return {
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
      passRate: summary.passRate === null ? 0 : Math.round(summary.passRate * 1000) / 1000,
      sensorHumanAgreement: summary.sensorHumanAgreement === null ? 0 : Math.round(summary.sensorHumanAgreement * 1000) / 1000,
      byGroup: Object.fromEntries(Object.entries(summary.byGroup).map(([k, b]) => [k, slim(b)])),
      byTag: Object.fromEntries(Object.entries(summary.byTag).map(([k, b]) => [k, slim(b)])),
      byUtterance: Object.fromEntries(Object.entries(summary.byUtterance).map(([k, b]) => [k, {
        ...slim(b), ...(b.medianLatencyMs == null ? {} : { medianLatencyMs: b.medianLatencyMs }),
      }])),
    },
  };
}

function needData() {
  if (!app.state || !app.state.trials.length) { toast("还没有数据", true); return false; }
  return true;
}

function exportSession() {
  if (!needData()) return;
  store.downloadJson(`saycheck-${app.state.suiteId}-${store.timestampSlug()}.session.json`, sessionDoc());
  toast("已导出 JSON");
}

function exportTrials() {
  if (!needData()) return;
  const csv = stats.trialsCsv(sessionDoc(), app.suite.utterances);
  store.downloadCsv(`saycheck-${app.state.suiteId}-${store.timestampSlug()}-trials.csv`, csv);
  toast("已导出逐轮明细");
}

function exportRanking() {
  if (!needData()) return;
  const summary = stats.summarize(app.state.trials, app.suite.utterances);
  store.downloadCsv(`saycheck-${app.state.suiteId}-${store.timestampSlug()}-ranking.csv`,
    stats.rankingCsv(summary, app.suite.utterances));
  toast("已导出排行");
}

// ------------------------------------------------------------------- wiring

function bind() {
  $("btn-start").onclick = () => start({ fresh: false });
  $("btn-stop").onclick = stop;
  $("btn-pass").onclick = () => onVerdict("pass");
  $("btn-fail").onclick = () => onVerdict("fail");
  $("btn-replay").onclick = replay;

  $("btn-load-suite").onclick = () => loadSuiteIntoApp($("suite-url").value.trim());
  $("btn-pick-file").onclick = () => $("file-input").click();
  $("file-input").onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) await loadSuiteIntoApp(f);
  };

  $("btn-check-devices").onclick = checkDevices;
  $("btn-calibrate").onclick = calibrate;

  $("btn-export-session").onclick = exportSession;
  $("btn-export-trials").onclick = exportTrials;
  $("btn-export-ranking").onclick = exportRanking;

  $("btn-clear").onclick = () => {
    if (!app.suite) return;
    if (!window.confirm("清空这套题在本机的全部测试记录？已导出的文件不受影响。")) return;
    store.clearState(app.suite.id);
    app.state = null;
    renderAll();
    toast("已清空本机记录");
  };

  for (const id of ["opt-rounds", "opt-rms", "opt-motion"]) {
    $(id).addEventListener("input", () => { updateMeterMarks(); renderToolbar(); });
  }
  for (const id of ["opt-window", "opt-settle", "opt-silence"]) {
    $(id).addEventListener("input", updateMeterMarks);
  }

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    const k = e.key.toLowerCase();
    if (app.awaiting && (k === "y" || k === "1")) { e.preventDefault(); onVerdict("pass"); }
    else if (app.awaiting && (k === "n" || k === "2")) { e.preventDefault(); onVerdict("fail"); }
    else if (app.awaiting && (k === "r" || k === "3")) { e.preventDefault(); replay(); }
    else if (k === " " && app.running) { e.preventDefault(); stop(); }
  });

  window.addEventListener("beforeunload", (e) => {
    if (app.running && !app.awaiting) { e.preventDefault(); e.returnValue = ""; }
  });
}

async function boot() {
  bind();
  startMeterLoop();
  resetMeters();
  updateMeterMarks();

  const params = new URLSearchParams(location.search);
  if (params.get("suite")) $("suite-url").value = params.get("suite");
  const api = params.get("api");
  if (api) window.__SAYCHECK_API__ = api;

  const ok = await loadSuiteIntoApp($("suite-url").value.trim());
  if (ok && params.get("autostart") === "1") {
    await checkDevices();
    await calibrate();
    await start({ fresh: false });
  }
}

boot();
