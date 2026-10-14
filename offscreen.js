// Offscreen document — a hidden extension page that background.js creates
// for the duration of a gut test session. It does the two things a MV3
// service worker can't do itself:
//
//  1. Play background music. A service worker has no audio output, so the
//     music lives here. By default it's a small self-generated chillhop
//     groove (drums, bass, Rhodes-style chords and a melody that varies per
//     loop) built with the Web Audio API — no audio file, so nothing to
//     license. Drop your own track at music/achtergrond.mp3 and that plays
//     (looped) instead.
//
//  2. Keep the live connection to the client's phone open. A service worker
//     gets killed after ~30s idle and can't hold a long-lived stream; this
//     page can. It listens to the session's ntfy.sh topic (see gte_data.js,
//     "Phone notes") and forwards every incoming note to background.js.

const RELAY = 'https://ntfy.sh';

// ============================================================================
// Music
// ============================================================================

const BPM = 94;
const STEP = 60 / BPM / 4;      // one 16th note, in seconds
const SWING = 0.22;             // off-beat 16ths are pushed late by this fraction of a step
const LOOKAHEAD = 1.2;          // seconds scheduled ahead — generous, so a throttled timer never leaves gaps
const TICK_MS = 150;
const CUSTOM_TRACK = 'music/achtergrond.mp3';

let ctx = null;
let master = null;              // volume + fades
let musicBus = null;            // everything → compressor → master
let reverbSend = null;
let delaySend = null;
let keysBus = null;
let noiseBuffer = null;
let schedulerId = null;
let nextStepTime = 0;
let stepIndex = 0;
let isPlaying = false;
let volume = 0.5;
let crackleSource = null;
let customAudio = null;          // <audio> element when a custom track is used
let melodyCache = new Map();     // phrase key -> [{ step, midi, len }]

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Chord progressions: [bass root, [chord voicing]] — warm, jazzy, upbeat.
// A: Dm9 – G13 – Cmaj9 – A7   (ii–V–I–VI in C)
// B: Fmaj9 – Em7 – Am9 – G13
const PROG_A = [
  [38, [53, 57, 60, 64]],
  [43, [53, 59, 64, 69]],
  [36, [52, 55, 59, 62]],
  [45, [55, 61, 64, 67]]
];
const PROG_B = [
  [41, [52, 55, 57, 64]],
  [40, [50, 55, 59, 62]],
  [45, [55, 59, 60, 64]],
  [43, [53, 59, 64, 69]]
];
const MELODY_SCALE = [69, 72, 74, 76, 79, 81, 84, 86]; // C major pentatonic, A4–D6

// Arrangement: a 4-bar intro, then a 32-bar loop that repeats forever.
function sectionForBar(bar) {
  if (bar < 4) return { name: 'intro', prog: PROG_A, drums: false, bass: false, melody: false, hats: true };
  const loopBar = (bar - 4) % 32;
  const loopNo = Math.floor((bar - 4) / 32);
  if (loopBar < 8) return { name: 'A1', prog: PROG_A, drums: true, bass: true, melody: loopNo > 0, hats: true, seed: loopNo * 7 + 1 };
  if (loopBar < 16) return { name: 'B1', prog: PROG_B, drums: true, bass: true, melody: true, hats: true, seed: loopNo * 7 + 2 };
  if (loopBar < 24) return { name: 'A2', prog: PROG_A, drums: true, bass: true, melody: true, hats: true, seed: loopNo * 7 + 3 };
  if (loopBar < 30) return { name: 'B2', prog: PROG_B, drums: true, bass: true, melody: true, hats: true, seed: loopNo * 7 + 4 };
  return { name: 'break', prog: PROG_A, drums: false, bass: false, melody: false, hats: true };
}

function mulberry32(seed) {
  return function rand() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A two-bar melodic phrase, generated once per (section, seed) and then
// repeated — so it sounds like a hook instead of random notes.
function melodyPhrase(seed) {
  if (melodyCache.has(seed)) return melodyCache.get(seed);
  const rand = mulberry32(seed * 9973 + 17);
  const slots = [0, 3, 6, 8, 10, 12, 14, 16, 19, 22, 24, 26, 28];
  const notes = [];
  let idx = 3 + Math.floor(rand() * 3);
  for (const step of slots) {
    const keep = step === 0 || step === 16 ? 0.95 : 0.5;
    if (rand() > keep) continue;
    idx = Math.max(0, Math.min(MELODY_SCALE.length - 1, idx + Math.floor(rand() * 5) - 2));
    notes.push({ step, midi: MELODY_SCALE[idx], len: rand() < 0.3 ? 4 : 2 });
  }
  melodyCache.set(seed, notes);
  return notes;
}

function ensureContext() {
  if (ctx) return;
  ctx = new AudioContext();

  master = ctx.createGain();
  master.gain.value = 0;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 3;
  comp.attack.value = 0.01;
  comp.release.value = 0.2;
  const warmth = ctx.createBiquadFilter();
  warmth.type = 'lowpass';
  warmth.frequency.value = 11000;
  musicBus = ctx.createGain();
  musicBus.connect(comp);
  comp.connect(warmth);
  warmth.connect(master);
  master.connect(ctx.destination);

  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  // Small generated room reverb.
  const reverb = ctx.createConvolver();
  const irLen = Math.floor(ctx.sampleRate * 1.8);
  const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < irLen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3);
  }
  reverb.buffer = ir;
  reverbSend = ctx.createGain();
  reverbSend.gain.value = 0.35;
  reverbSend.connect(reverb);
  reverb.connect(musicBus);

  // Dotted-eighth echo for the melody.
  const delay = ctx.createDelay(2);
  delay.delayTime.value = STEP * 3;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.32;
  const delayTone = ctx.createBiquadFilter();
  delayTone.type = 'lowpass';
  delayTone.frequency.value = 2800;
  delaySend = ctx.createGain();
  delaySend.gain.value = 0.4;
  delaySend.connect(delay);
  delay.connect(delayTone);
  delayTone.connect(feedback);
  feedback.connect(delay);
  delayTone.connect(musicBus);

  // Keys get a gentle tremolo, like a real Rhodes.
  keysBus = ctx.createGain();
  keysBus.gain.value = 1;
  const trem = ctx.createOscillator();
  trem.frequency.value = 4.2;
  const tremDepth = ctx.createGain();
  tremDepth.gain.value = 0.18;
  trem.connect(tremDepth);
  tremDepth.connect(keysBus.gain);
  trem.start();
  const keysTone = ctx.createBiquadFilter();
  keysTone.type = 'lowpass';
  keysTone.frequency.value = 3200;
  keysBus.connect(keysTone);
  keysTone.connect(musicBus);
  keysTone.connect(reverbSend);
}

function noiseSource(t, dur) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur);
  return src;
}

function kick(t, vel = 1) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(46, t + 0.12);
  g.gain.setValueAtTime(0.95 * vel, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
  o.connect(g); g.connect(musicBus);
  o.start(t); o.stop(t + 0.45);
}

function snare(t, vel = 1) {
  const n = noiseSource(t, 0.25);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.7;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.38 * vel, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  n.connect(bp); bp.connect(ng); ng.connect(musicBus); ng.connect(reverbSend);

  const o = ctx.createOscillator();
  const og = ctx.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(200, t);
  o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
  og.gain.setValueAtTime(0.3 * vel, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  o.connect(og); og.connect(musicBus);
  o.start(t); o.stop(t + 0.12);
}

function hat(t, vel = 1, open = false) {
  const dur = open ? 0.28 : 0.045;
  const n = noiseSource(t, dur + 0.02);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 7200;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.13 * vel, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  n.connect(hp); hp.connect(g); g.connect(musicBus);
}

function bass(midi, t, dur) {
  const f = mtof(midi);
  const o1 = ctx.createOscillator();
  const o2 = ctx.createOscillator();
  o1.type = 'triangle'; o1.frequency.value = f;
  o2.type = 'sine'; o2.frequency.value = f;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.42, t + 0.012);
  g.gain.setTargetAtTime(0.28, t + 0.02, 0.15);
  g.gain.setTargetAtTime(0, t + dur, 0.05);
  o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(musicBus);
  o1.start(t); o2.start(t);
  o1.stop(t + dur + 0.4); o2.stop(t + dur + 0.4);
}

function keys(notes, t, dur, vel = 1) {
  notes.forEach((midi, i) => {
    const tt = t + i * 0.011; // tiny strum
    const f = mtof(midi);
    const body = ctx.createOscillator();
    const tine = ctx.createOscillator();
    body.type = 'sine'; body.frequency.value = f;
    tine.type = 'sine'; tine.frequency.value = f * 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, tt);
    g.gain.linearRampToValueAtTime(0.12 * vel, tt + 0.01);
    g.gain.setTargetAtTime(0.065 * vel, tt + 0.02, 0.3);
    g.gain.setTargetAtTime(0, tt + dur, 0.12);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.03 * vel, tt);
    tg.gain.setTargetAtTime(0, tt, 0.06);
    body.connect(g); tine.connect(tg); tg.connect(g); g.connect(keysBus);
    body.start(tt); tine.start(tt);
    body.stop(tt + dur + 0.8); tine.stop(tt + dur + 0.8);
  });
}

function pluck(midi, t, dur) {
  const f = mtof(midi);
  const o = ctx.createOscillator();
  const o2 = ctx.createOscillator();
  o.type = 'triangle'; o.frequency.value = f;
  o2.type = 'sine'; o2.frequency.value = f * 2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.11, t + 0.006);
  g.gain.setTargetAtTime(0, t + 0.01, Math.min(0.35, dur * 0.6));
  const g2 = ctx.createGain();
  g2.gain.value = 0.25;
  o.connect(g); o2.connect(g2); g2.connect(g);
  g.connect(musicBus); g.connect(delaySend); g.connect(reverbSend);
  o.start(t); o2.start(t);
  o.stop(t + dur + 1); o2.stop(t + dur + 1);
}

function scheduleStep(index, time) {
  const bar = Math.floor(index / 16);
  const s = index % 16;
  const sec = sectionForBar(bar);
  const [root, chord] = sec.prog[bar % 4];
  const human = () => (Math.random() - 0.5) * 0.008;

  // Chords: long hit on the 1, short pushes on the "and"s.
  if (s === 0) keys(chord, time + human(), STEP * 5.5, 1);
  if (s === 7) keys(chord, time + human(), STEP * 1.6, 0.7);
  if (s === 10) keys(chord, time + human(), STEP * 4.5, 0.85);

  if (sec.drums) {
    if (s === 0 || s === 10) kick(time);
    if (s === 7 && bar % 2 === 1) kick(time, 0.6);
    if (s === 4 || s === 12) snare(time + 0.004);
    if (s === 15 && bar % 4 === 3) snare(time, 0.35);
  }
  if (sec.hats) {
    if (s % 2 === 0) hat(time + human(), s % 4 === 0 ? 1 : 0.6, sec.drums && s === 14 && bar % 2 === 1);
    else if (sec.drums && (s === 11 || s === 15)) hat(time, 0.35);
  }

  if (sec.bass) {
    if (s === 0) bass(root, time, STEP * 5);
    if (s === 6) bass(root + 12, time, STEP * 1);
    if (s === 7) bass(root, time, STEP * 2);
    if (s === 10) bass(root + 7, time, STEP * 3);
    if (s === 14) bass(root + 10, time, STEP * 1.5);
  }

  if (sec.melody) {
    const phrase = melodyPhrase(sec.seed);
    const phraseStep = (bar % 2) * 16 + s;
    for (const n of phrase) {
      if (n.step === phraseStep) pluck(n.midi, time + human(), STEP * n.len);
    }
  }
}

function scheduler() {
  while (nextStepTime < ctx.currentTime + LOOKAHEAD) {
    const swing = stepIndex % 2 === 1 ? STEP * SWING : 0;
    scheduleStep(stepIndex, nextStepTime + swing);
    nextStepTime += STEP;
    stepIndex++;
  }
}

function startCrackle() {
  const len = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    d[i] = (Math.random() * 2 - 1) * 0.004;
    if (Math.random() < 0.0004) d[i] += (Math.random() * 2 - 1) * 0.35;
  }
  crackleSource = ctx.createBufferSource();
  crackleSource.buffer = buf;
  crackleSource.loop = true;
  const g = ctx.createGain();
  g.gain.value = 0.25;
  crackleSource.connect(g);
  g.connect(musicBus);
  crackleSource.start();
}

async function customTrackAvailable() {
  try {
    const res = await fetch(chrome.runtime.getURL(CUSTOM_TRACK));
    return res.ok;
  } catch (e) {
    return false;
  }
}

function targetLevel() { return 0.9 * volume; }

async function playMusic(vol) {
  if (typeof vol === 'number') setVolume(vol);
  ensureContext();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  if (isPlaying) return;
  isPlaying = true;

  if (await customTrackAvailable()) {
    if (!customAudio) {
      customAudio = new Audio(chrome.runtime.getURL(CUSTOM_TRACK));
      customAudio.loop = true;
      ctx.createMediaElementSource(customAudio).connect(master);
    }
    customAudio.currentTime = 0;
    customAudio.play().catch(() => {});
  } else {
    // A stop→play right after each other (new session) can land while the
    // previous fade-out hasn't cleaned up yet — clear that first so two
    // schedulers never run at once.
    if (schedulerId) { clearInterval(schedulerId); schedulerId = null; }
    if (crackleSource) { try { crackleSource.stop(); } catch (e) { /* ignore */ } crackleSource = null; }
    melodyCache = new Map();
    stepIndex = 0;
    nextStepTime = ctx.currentTime + 0.15;
    startCrackle();
    scheduler();
    schedulerId = setInterval(scheduler, TICK_MS);
  }

  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(master.gain.value, now);
  master.gain.linearRampToValueAtTime(targetLevel(), now + 2);
}

function stopMusic() {
  if (!isPlaying || !ctx) return;
  isPlaying = false;
  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(master.gain.value, now);
  master.gain.linearRampToValueAtTime(0, now + 1.2);
  setTimeout(() => {
    if (isPlaying) return; // restarted during the fade
    if (schedulerId) { clearInterval(schedulerId); schedulerId = null; }
    if (crackleSource) { try { crackleSource.stop(); } catch (e) { /* ignore */ } crackleSource = null; }
    if (customAudio) customAudio.pause();
  }, 1300);
}

function setVolume(vol) {
  volume = Math.max(0, Math.min(1, Number(vol)));
  if (ctx && isPlaying) {
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setTargetAtTime(targetLevel(), now, 0.1);
  }
}

// ============================================================================
// Phone relay (ntfy.sh server-sent events)
// ============================================================================

let relaySource = null;
let relayTopic = null;

function startRelay(topic, since) {
  if (!topic) return;
  if (relaySource && relayTopic === topic && relaySource.readyState !== EventSource.CLOSED) return;
  stopRelay();
  relayTopic = topic;
  // `since` lets us pick up notes typed while this page wasn't listening
  // (e.g. during the intro). EventSource reconnects on its own with the same
  // URL after a dropped connection, so a few messages can arrive twice —
  // background.js de-duplicates on the message id.
  const sinceParam = encodeURIComponent(since || '10m');
  relaySource = new EventSource(`${RELAY}/${topic}/sse?since=${sinceParam}`);
  relaySource.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch (e) { return; }
    if (!data || data.event !== 'message' || typeof data.message !== 'string') return;
    chrome.runtime.sendMessage({
      target: 'background',
      command: 'phoneMessage',
      id: data.id,
      time: data.time,
      message: data.message
    }).catch(() => {});
  };
}

function stopRelay() {
  if (relaySource) { relaySource.close(); relaySource = null; }
  relayTopic = null;
}

// ============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.target !== 'offscreen') return false;
  switch (request.command) {
    case 'playMusic': playMusic(request.volume); break;
    case 'stopMusic': stopMusic(); break;
    case 'setVolume': setVolume(request.volume); break;
    case 'startRelay': startRelay(request.topic, request.since); break;
    case 'stopRelay': stopRelay(); break;
    case 'ping': sendResponse({ alive: true, playing: isPlaying, relay: relayTopic }); return false;
    default: return false;
  }
  return false;
});
