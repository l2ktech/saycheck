// Suite loading, light validation, and audio URL resolution.
// No dependencies: this file must work by opening index.html from disk.

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export class SuiteError extends Error {}

/** Fetch and parse a suite. `url` may be relative to the page. */
export async function loadSuite(url) {
  let res;
  try {
    res = await fetch(url, { cache: "no-cache" });
  } catch (err) {
    throw new SuiteError(
      `Cannot read ${url}. If you opened this file directly from disk, ` +
      `browsers block fetch() on file:// URLs — start a local server instead:\n` +
      `  python3 -m http.server 8000`
    );
  }
  if (!res.ok) throw new SuiteError(`${url} returned HTTP ${res.status}`);
  const doc = await res.json();
  const suite = validateSuite(doc);
  suite._url = new URL(url, location.href).href;
  suite._doc = doc;
  return suite;
}

/** Parse a suite from an already-read File object (drag & drop or file picker). */
export async function loadSuiteFromFile(file) {
  const text = await file.text();
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new SuiteError(`${file.name} is not valid JSON: ${err.message}`);
  }
  const suite = validateSuite(doc);
  suite._url = new URL(file.name, location.href).href;
  suite._doc = doc;
  return suite;
}

/**
 * Validate, throwing on the first problem. Deliberately mirrors
 * scripts/validate.py but only checks what the runner actually depends on.
 */
export function validateSuite(doc) {
  const fail = (msg) => { throw new SuiteError(msg); };

  if (!doc || typeof doc !== "object") fail("Suite must be a JSON object.");
  if (doc.schemaVersion !== "1.0") fail(`Unsupported schemaVersion: ${doc.schemaVersion}`);
  if (!ID_RE.test(doc.id || "")) fail(`Invalid suite id: ${doc.id}`);
  if (!doc.title) fail("Suite is missing a title.");
  if (!Array.isArray(doc.utterances) || doc.utterances.length === 0) fail("Suite has no utterances.");

  const groupIds = new Set((doc.groups || []).map((g) => g.id));
  const seen = new Set();

  doc.utterances.forEach((u, i) => {
    if (!u.id) fail(`utterances[${i}] has no id`);
    if (seen.has(u.id)) fail(`Duplicate utterance id: ${u.id}`);
    seen.add(u.id);
    if (!u.text || !u.text.trim()) fail(`utterances[${i}] (${u.id}) has no text`);
    if (u.groupId && !groupIds.has(u.groupId)) fail(`${u.id} references unknown groupId ${u.groupId}`);
  });

  const groups = (doc.groups || []).filter((g) =>
    doc.utterances.some((u) => u.groupId === g.id)
  );

  return {
    schemaVersion: doc.schemaVersion,
    id: doc.id,
    title: doc.title,
    description: doc.description || "",
    locale: doc.locale || "",
    audioBase: doc.audioBase || "",
    wake: doc.wake || null,
    groups,
    utterances: doc.utterances,
    defaults: Object.assign(
      {
        rounds: 5,
        gapMs: 1500,
        windowMs: 5000,
        settleMs: 900,
        silenceMs: 1000,
        rmsPeakDb: -34,
        frameDiff: 3,
        rule: "any",
        judgeMode: "manual",
        useWake: true,
        recordFailedOnly: true,
      },
      doc.defaults || {}
    ),
  };
}

/** Absolute URL for an utterance's audio, or null when it has none. */
export function audioUrl(suite, utterance) {
  if (!utterance.audio || !utterance.audio.path) return null;
  const path = (suite.audioBase || "") + utterance.audio.path;
  try {
    return new URL(path, suite._url).href;
  } catch {
    return null;
  }
}

/** Absolute URL for the wake clip, or null when the suite has none. */
export function wakeUrl(suite) {
  if (!suite.wake || !suite.wake.audio) return null;
  const path = (suite.audioBase || "") + suite.wake.audio;
  try {
    return new URL(path, suite._url).href;
  } catch {
    return null;
  }
}

/** Which utterances to run, honouring the active group filter. */
export function selectUtterances(suite, activeGroupIds) {
  if (!activeGroupIds || activeGroupIds.size === 0) return suite.utterances;
  return suite.utterances.filter((u) => activeGroupIds.has(u.groupId));
}

export function groupOf(suite, utterance) {
  return suite.groups.find((g) => g.id === utterance.groupId) || null;
}
