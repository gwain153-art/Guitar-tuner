"use strict";

// ---------- Constants ----------
const IN_TUNE_CENTS = 4;       // within this = in tune
const CLOSE_CENTS = 15;        // within this = nearly there
const TUNED_HOLD_MS = 700;     // how long a string must stay in tune to get a tick
const SILENCE_HOLD_MS = 1200;  // keep showing the last reading this long after the note dies
const RMS_GATE = 0.006;        // ignore input quieter than this
const YIN_THRESHOLD = 0.12;
const HISTORY = 5;             // median filter length
const CUSTOM = "__custom__";
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// ---------- Note helpers ----------
function noteToMidi(note) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(note);
  if (!m) throw new Error("Bad note " + note);
  const acc = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + PC[m[1]] + acc;
}
const midiToNote = (midi) => NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
const midiToFreq = (midi, a4) => a4 * Math.pow(2, (midi - 69) / 12);
const freqToMidi = (f, a4) => 69 + 12 * Math.log2(f / a4);

function splitNote(note) {
  const m = /^([A-G][#b]?)(-?\d)$/.exec(note);
  return { pitch: m[1].replace("#", "♯").replace("b", "♭"), octave: m[2] };
}
function noteHTML(note) {
  const { pitch, octave } = splitNote(note);
  return `${pitch[0]}${pitch.length > 1 ? `<span class="acc">${pitch.slice(1)}</span>` : ""}<sub>${octave}</sub>`;
}

// ---------- Persistent settings ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("tuner." + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("tuner." + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const state = {
  instrument: store.get("instrument", "guitar6"),
  tuning: store.get("tuning", "0"),
  a4: store.get("a4", 440),
  mode: store.get("mode", "auto"),
  sound: store.get("sound", false),
  lockedIndex: 0,
  activeIndex: -1,
  tuned: new Set(),
  inTuneSince: 0,
};
if (!INSTRUMENTS[state.instrument]) state.instrument = "guitar6";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  instrument: $("instrument"),
  tuning: $("tuning"),
  custom: $("custom"),
  customStrings: $("custom-strings"),
  customReset: $("custom-reset"),
  meter: document.querySelector(".meter"),
  needle: $("needle"),
  note: $("note"),
  cents: $("cents"),
  freq: $("freq"),
  hint: $("hint"),
  strings: $("strings"),
  start: $("start"),
  a4: $("a4"),
  sound: $("sound"),
  status: $("status"),
};

// ---------- Tuning data ----------
function customNotes(instKey) {
  const inst = INSTRUMENTS[instKey];
  const saved = store.get("custom." + instKey, null);
  if (Array.isArray(saved) && saved.length === inst.strings) return saved;
  return inst.tunings[0].notes.slice();
}

function currentNotes() {
  if (state.tuning === CUSTOM) return customNotes(state.instrument);
  const t = INSTRUMENTS[state.instrument].tunings[Number(state.tuning)];
  return t ? t.notes : INSTRUMENTS[state.instrument].tunings[0].notes;
}

function currentStrings() {
  return currentNotes().map((note) => {
    const midi = noteToMidi(note);
    return { note, midi, freq: midiToFreq(midi, state.a4) };
  });
}

// ---------- Building the UI ----------
function buildInstrumentSelect() {
  els.instrument.innerHTML = Object.entries(INSTRUMENTS)
    .map(([key, inst]) => `<option value="${key}">${inst.name}</option>`)
    .join("");
  els.instrument.value = state.instrument;
}

function buildTuningSelect() {
  const inst = INSTRUMENTS[state.instrument];
  let html = "";
  let openGroup = null;
  inst.tunings.forEach((t, i) => {
    if (t.group !== openGroup) {
      if (openGroup) html += "</optgroup>";
      if (t.group) html += `<optgroup label="${t.group}">`;
      openGroup = t.group;
    }
    const label = `${t.name}  (${t.notes.map((n) => splitNote(n).pitch).join(" ")})`;
    html += `<option value="${i}">${label}</option>`;
  });
  if (openGroup) html += "</optgroup>";
  html += `<option value="${CUSTOM}">Custom…</option>`;
  els.tuning.innerHTML = html;
  if (state.tuning !== CUSTOM && !inst.tunings[Number(state.tuning)]) state.tuning = "0";
  els.tuning.value = state.tuning;
}

function buildCustomEditor() {
  const isCustom = state.tuning === CUSTOM;
  els.custom.hidden = !isCustom;
  if (!isCustom) return;
  const notes = customNotes(state.instrument);
  // Offer A0..C6, covers everything from 5-string bass to mandolin
  const options = [];
  for (let m = noteToMidi("A0"); m <= noteToMidi("C6"); m++) options.push(midiToNote(m));
  els.customStrings.innerHTML = notes
    .map((note, i) => {
      const selMidi = noteToMidi(note);
      const opts = options
        .map((n) => `<option value="${n}"${noteToMidi(n) === selMidi ? " selected" : ""}>${splitNote(n).pitch}${splitNote(n).octave}</option>`)
        .join("");
      return `<select data-index="${i}" aria-label="String ${notes.length - i}">${opts}</select>`;
    })
    .join("");
}

function buildStrings() {
  const strings = currentStrings();
  els.strings.innerHTML = strings
    .map((s, i) => `
      <button type="button" class="string" data-index="${i}">
        <span class="num">${strings.length - i}</span>
        <span class="name">${noteHTML(s.note)}</span>
        <span class="hz">${s.freq.toFixed(1)}</span>
      </button>`)
    .join("");
  if (state.lockedIndex >= strings.length) state.lockedIndex = 0;
  state.activeIndex = -1;
  updateStringClasses();
}

function updateStringClasses() {
  els.strings.classList.toggle("hidden", state.mode === "chromatic");
  [...els.strings.children].forEach((btn, i) => {
    btn.classList.toggle("locked", state.mode === "manual" && i === state.lockedIndex);
    btn.classList.toggle("active", state.mode === "auto" && i === state.activeIndex);
    btn.classList.toggle("tuned", state.tuned.has(i));
  });
}

function buildGauge() {
  // -50..+50 cents mapped to -60..+60 degrees around (150,160)
  const cx = 150, cy = 160, r = 130;
  let html = "";
  for (let c = -50; c <= 50; c += 5) {
    const a = (c / 50) * 60 * Math.PI / 180;
    const major = c % 25 === 0;
    const len = c === 0 ? 20 : major ? 14 : 8;
    const x1 = cx + r * Math.sin(a), y1 = cy - r * Math.cos(a);
    const x2 = cx + (r - len) * Math.sin(a), y2 = cy - (r - len) * Math.cos(a);
    const cls = c === 0 ? "tick center" : major ? "tick major" : "tick";
    html += `<line class="${cls}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    if (major) {
      const lx = cx + (r + 14) * Math.sin(a), ly = cy - (r + 14) * Math.cos(a) + 4;
      html += `<text class="tick-label" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}">${c > 0 ? "+" + c : c}</text>`;
    }
  }
  document.getElementById("ticks").innerHTML = html;
  // Shaded in-tune zone
  const za = (IN_TUNE_CENTS / 50) * 60 * Math.PI / 180, zr = r - 7;
  const p = (s) => `${(cx + zr * Math.sin(s * za)).toFixed(1)} ${(cy - zr * Math.cos(s * za)).toFixed(1)}`;
  document.querySelector(".gauge .zone").setAttribute("d", `M ${p(-1)} A ${zr} ${zr} 0 0 1 ${p(1)}`);
}

function syncControls() {
  els.a4.textContent = state.a4;
  els.sound.checked = state.sound;
  document.querySelectorAll(".segmented button").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.mode === state.mode));
  });
}

function rebuildAll() {
  buildTuningSelect();
  buildCustomEditor();
  state.tuned.clear();
  buildStrings();
  resetReadout();
}

// ---------- Audio ----------
let audioCtx = null;
let analyser = null;
let micStream = null;
let buffer = null;
let running = false;
let wakeLock = null;

function ensureAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    els.status.textContent = "Microphone not available. The page must be served over HTTPS (or localhost).";
    return;
  }
  try {
    ensureAudioContext();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const source = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 4096;
    source.connect(analyser);
    buffer = new Float32Array(analyser.fftSize);
    running = true;
    els.start.textContent = "Stop";
    els.start.classList.add("on");
    els.status.textContent = "";
    els.cents.textContent = "Play a string";
    requestWakeLock();
    requestAnimationFrame(loop);
  } catch (err) {
    els.status.textContent = err.name === "NotAllowedError"
      ? "Microphone permission denied. Allow it in your browser settings and try again."
      : "Couldn't open the microphone: " + err.message;
  }
}

function stopMic() {
  running = false;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  analyser = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  els.start.textContent = "Start tuning";
  els.start.classList.remove("on");
  resetReadout();
  els.cents.textContent = "Tap start and play a string";
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* not supported */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running) requestWakeLock();
});

// Karplus-Strong plucked string as a reference tone. The delay line is an
// integer length, so we correct the final pitch with playbackRate.
function pluck(freq) {
  const ctx = ensureAudioContext();
  const sr = ctx.sampleRate;
  const period = Math.max(2, Math.round(sr / freq));
  const generated = sr / (period - 0.5); // averaging with the next sample makes the loop half a sample shorter
  const duration = 2.5;
  const length = Math.floor(sr * duration);
  const buf = ctx.createBuffer(1, length, sr);
  const out = buf.getChannelData(0);
  const decay = freq < 100 ? 0.998 : 0.996;
  for (let i = 0; i < period; i++) out[i] = Math.random() * 2 - 1;
  for (let i = period; i < length; i++) {
    out[i] = decay * 0.5 * (out[i - period] + out[i - period + 1]);
  }
  // Smooth the attack slightly so it doesn't click
  for (let i = 0; i < 64 && i < length; i++) out[i] *= i / 64;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = freq / generated;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.5, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  src.connect(gain).connect(ctx.destination);
  src.start();
}

// ---------- Pitch detection (YIN) ----------
let yinDiff = null;
let yinCmnd = null;

function detectPitch(buf, sr, minF, maxF) {
  const maxTau = Math.min(Math.floor(sr / minF), buf.length >> 1);
  const minTau = Math.max(2, Math.floor(sr / maxF));
  const W = Math.min(buf.length - maxTau, 2048);
  if (!yinDiff || yinDiff.length < maxTau + 2) {
    yinDiff = new Float32Array(maxTau + 2);
    yinCmnd = new Float32Array(maxTau + 2);
  }
  const d = yinDiff, cm = yinCmnd;

  // Difference function
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let j = 0; j < W; j++) {
      const delta = buf[j] - buf[j + tau];
      sum += delta * delta;
    }
    d[tau] = sum;
  }

  // Cumulative mean normalised difference
  cm[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += d[tau];
    cm[tau] = running === 0 ? 1 : (d[tau] * tau) / running;
  }

  // First dip under the threshold, then walk down to its local minimum
  let tau = -1;
  for (let t = minTau; t < maxTau; t++) {
    if (cm[t] < YIN_THRESHOLD) {
      while (t + 1 < maxTau && cm[t + 1] < cm[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau === -1) return null;

  // Parabolic interpolation for sub-sample accuracy
  let better = tau;
  if (tau > 1 && tau < maxTau) {
    const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) better = tau + (a - c) / (2 * denom);
  }
  return sr / better;
}

function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

// ---------- Main loop ----------
const history = [];
let lastPitchAt = 0;
let shownCents = 0;
let targetCents = 0;

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function detectionRange() {
  const strings = currentStrings();
  const lo = Math.min(...strings.map((s) => s.freq));
  const hi = Math.max(...strings.map((s) => s.freq));
  const minF = Math.max(26, lo * 0.6);
  const maxF = state.mode === "chromatic" ? 1500 : Math.min(1500, Math.max(500, hi * 2.5));
  return { minF, maxF };
}

function loop(now) {
  if (!running) return;
  analyser.getFloatTimeDomainData(buffer);

  let freq = null;
  if (rms(buffer) > RMS_GATE) {
    const { minF, maxF } = detectionRange();
    freq = detectPitch(buffer, audioCtx.sampleRate, minF, maxF);
  }

  if (freq) {
    history.push(freq);
    if (history.length > HISTORY) history.shift();
    lastPitchAt = now;
    if (history.length >= 3) update(median(history), now);
  } else if (now - lastPitchAt > SILENCE_HOLD_MS && lastPitchAt !== -1) {
    history.length = 0;
    lastPitchAt = -1;
    resetReadout();
  } else if (now - lastPitchAt > 150) {
    history.length = 0;
  }

  // Ease the needle towards the target so it doesn't jitter
  shownCents += (targetCents - shownCents) * 0.25;
  els.needle.style.transform = `rotate(${(Math.max(-50, Math.min(50, shownCents)) / 50) * 60}deg)`;

  requestAnimationFrame(loop);
}

function pickTarget(freq) {
  const strings = currentStrings();
  const midi = freqToMidi(freq, state.a4);

  if (state.mode === "chromatic") {
    const nearest = Math.round(midi);
    return { note: midiToNote(nearest), cents: (midi - nearest) * 100, index: -1 };
  }

  if (state.mode === "manual") {
    const s = strings[state.lockedIndex];
    return { note: s.note, cents: (midi - s.midi) * 100, index: state.lockedIndex };
  }

  // Auto: nearest string, with a little hysteresis so it doesn't flicker
  let best = 0;
  strings.forEach((s, i) => {
    if (Math.abs(midi - s.midi) < Math.abs(midi - strings[best].midi)) best = i;
  });
  const cur = state.activeIndex;
  if (cur >= 0 && cur < strings.length && cur !== best) {
    const curDist = Math.abs(midi - strings[cur].midi);
    const bestDist = Math.abs(midi - strings[best].midi);
    if (curDist - bestDist < 0.4) best = cur;
  }
  state.activeIndex = best;
  const s = strings[best];
  return { note: s.note, cents: (midi - s.midi) * 100, index: best };
}

function update(freq, now) {
  const t = pickTarget(freq);
  const abs = Math.abs(t.cents);
  targetCents = t.cents;

  els.note.innerHTML = noteHTML(t.note);
  els.freq.textContent = `${freq.toFixed(1)} Hz`;

  if (abs > 50) {
    const semis = t.cents / 100;
    els.cents.textContent = `${semis > 0 ? "+" : ""}${semis.toFixed(1)} semitones`;
  } else {
    const c = Math.round(t.cents);
    els.cents.textContent = `${c > 0 ? "+" : ""}${c} cents`;
  }

  let cls, hint;
  if (abs <= IN_TUNE_CENTS) { cls = "in-tune"; hint = "In tune"; }
  else if (abs <= CLOSE_CENTS) { cls = "close"; hint = t.cents < 0 ? "Tune up a touch ↑" : "Tune down a touch ↓"; }
  else { cls = "far"; hint = t.cents < 0 ? "Too low, tune up ↑" : "Too high, tune down ↓"; }
  els.meter.className = "meter " + cls;
  els.hint.textContent = hint;

  // Mark string as tuned once it has held in tune for a moment
  if (t.index >= 0 && abs <= IN_TUNE_CENTS) {
    if (!state.inTuneSince) state.inTuneSince = now;
    if (now - state.inTuneSince > TUNED_HOLD_MS) state.tuned.add(t.index);
  } else {
    state.inTuneSince = 0;
  }
  updateStringClasses();
}

function resetReadout() {
  targetCents = 0;
  state.inTuneSince = 0;
  state.activeIndex = -1;
  els.meter.className = "meter idle";
  els.note.textContent = "--";
  els.freq.innerHTML = "&nbsp;";
  els.hint.innerHTML = "&nbsp;";
  if (running) els.cents.textContent = "Play a string";
  updateStringClasses();
}

// ---------- Events ----------
els.instrument.addEventListener("change", () => {
  state.instrument = els.instrument.value;
  state.tuning = "0";
  state.lockedIndex = 0;
  store.set("instrument", state.instrument);
  store.set("tuning", state.tuning);
  rebuildAll();
});

els.tuning.addEventListener("change", () => {
  state.tuning = els.tuning.value;
  store.set("tuning", state.tuning);
  buildCustomEditor();
  state.tuned.clear();
  buildStrings();
  resetReadout();
});

els.customStrings.addEventListener("change", (e) => {
  const sel = e.target.closest("select");
  if (!sel) return;
  const notes = customNotes(state.instrument);
  notes[Number(sel.dataset.index)] = sel.value;
  store.set("custom." + state.instrument, notes);
  state.tuned.clear();
  buildStrings();
});

els.customReset.addEventListener("click", () => {
  store.set("custom." + state.instrument, INSTRUMENTS[state.instrument].tunings[0].notes.slice());
  buildCustomEditor();
  state.tuned.clear();
  buildStrings();
});

els.strings.addEventListener("click", (e) => {
  const btn = e.target.closest(".string");
  if (!btn) return;
  const i = Number(btn.dataset.index);
  if (state.sound) pluck(currentStrings()[i].freq);
  // Tapping a string locks onto it, tapping the locked one again goes back to auto
  if (state.mode === "manual" && i === state.lockedIndex) {
    setMode("auto");
  } else {
    state.lockedIndex = i;
    setMode("manual");
  }
});

function setMode(mode) {
  state.mode = mode;
  store.set("mode", mode);
  syncControls();
  history.length = 0;
  resetReadout();
}

document.querySelector(".segmented").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (btn) setMode(btn.dataset.mode);
});

document.querySelectorAll("[data-a4]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.a4 = Math.max(400, Math.min(480, state.a4 + Number(btn.dataset.a4)));
    store.set("a4", state.a4);
    syncControls();
    buildStrings();
  });
});

els.sound.addEventListener("change", () => {
  state.sound = els.sound.checked;
  store.set("sound", state.sound);
  if (state.sound) ensureAudioContext();
});

els.start.addEventListener("click", () => (running ? stopMic() : startMic()));

// ---------- Init ----------
buildInstrumentSelect();
buildGauge();
syncControls();
rebuildAll();
