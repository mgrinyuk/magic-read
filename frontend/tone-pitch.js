/* =============================================================
   Tone pitch analysis (Chinese), on the device

   Azure scores a syllable against its expected tone but never says which
   tone was actually produced. This measures the voice's pitch itself:

     detectPitch(samples, sampleRate)  -> [{ t, f0 }]   (seconds, Hz; f0 0 = unvoiced)
     analyseWord(track, syllables, opts)
       -> { baseline, syllables: [{ ...syllable, start, end, contour, heard }] }
     classifyTone(points)              -> 1 | 2 | 3 | 4 | null

   Pitch is compared in semitones from the speaker's own middle (so a low
   and a high voice read the same), and only claims a tone when the shape is
   clear; otherwise heard is null and the app says nothing.
   ============================================================= */

const MIN_F0 = 70;
const MAX_F0 = 500;
const TARGET_RATE = 16000;

// Average-and-drop down to ~16 kHz: plenty for voice pitch, 3x less work.
function downsample(samples, rate) {
  const factor = Math.max(1, Math.round(rate / TARGET_RATE));
  if (factor === 1) return { data: samples, rate };
  const out = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += samples[i * factor + k];
    out[i] = s / factor;
  }
  return { data: out, rate: rate / factor };
}

// YIN pitch for one frame (de Cheveigné & Kawahara, 2002). Returns Hz or 0.
function yinFrame(frame, rate) {
  const minTau = Math.floor(rate / MAX_F0);
  const maxTau = Math.min(Math.floor(rate / MIN_F0), frame.length >> 1);
  const d = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i + tau < frame.length; i++) {
      const diff = frame[i] - frame[i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  // Cumulative mean normalised difference; first dip under the threshold,
  // else the deepest dip if it's still clearly periodic. A strict threshold
  // lost the voice exactly where pitch moves fast (the rise of a 2nd tone).
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += d[tau];
    d[tau] = running ? (d[tau] * tau) / running : 1;
  }
  let best = -1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (d[tau] < 0.22) {
      while (tau + 1 <= maxTau && d[tau + 1] < d[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    let min = minTau;
    for (let tau = minTau; tau <= maxTau; tau++) if (d[tau] < d[min]) min = tau;
    if (d[min] < 0.4) best = min;
  }
  if (best < 0) return 0;
  // Parabolic interpolation around the minimum for sub-sample accuracy.
  const a = d[best - 1] ?? d[best], b = d[best], c = d[best + 1] ?? d[best];
  const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
  return rate / (best + (Number.isFinite(shift) ? shift : 0));
}

export function detectPitch(samples, sampleRate) {
  const { data, rate } = downsample(samples, sampleRate);
  const win = Math.round(rate * 0.04);   // 40 ms window
  const hop = Math.round(rate * 0.01);   // every 10 ms
  const frames = [];
  let maxRms = 0;
  for (let start = 0; start + win <= data.length; start += hop) {
    const frame = data.subarray(start, start + win);
    let e = 0;
    for (let i = 0; i < frame.length; i++) e += frame[i] * frame[i];
    const rms = Math.sqrt(e / frame.length);
    maxRms = Math.max(maxRms, rms);
    frames.push({ t: (start + win / 2) / rate, rms, frame });
  }
  // Quiet frames are breath and room noise, not voice.
  const track = frames.map((f) => ({ t: f.t, f0: f.rms > maxRms * 0.04 ? yinFrame(f.frame, rate) : 0 }));
  return cleanTrack(track);
}

// Drop octave jumps and lone frames, then a 5-frame median.
function cleanTrack(track) {
  const voiced = track.filter((p) => p.f0 > 0).map((p) => p.f0).sort((a, b) => a - b);
  if (!voiced.length) return track;
  const med = voiced[voiced.length >> 1];
  const fixed = track.map((p) => {
    if (!p.f0) return p;
    let f = p.f0;
    if (f > med * 1.8) f /= 2;
    else if (f < med * 0.55) f *= 2;
    return { t: p.t, f0: f > med * 1.8 || f < med * 0.55 ? 0 : f };
  });
  const smooth = fixed.map((p, i) => {
    if (!p.f0) return p;
    const win = fixed.slice(Math.max(0, i - 2), i + 3).map((q) => q.f0).filter(Boolean).sort((a, b) => a - b);
    const lonely = win.length < 3;
    return { t: p.t, f0: lonely ? 0 : win[win.length >> 1] };
  });
  // Bridge short dropouts (up to 80 ms) inside the voice by interpolation.
  for (let i = 1; i < smooth.length; i++) {
    if (smooth[i].f0 || !smooth[i - 1].f0) continue;
    let j = i;
    while (j < smooth.length && !smooth[j].f0) j++;
    if (j < smooth.length && j - i <= 8) {
      const a = smooth[i - 1].f0, b = smooth[j].f0;
      for (let k = i; k < j; k++) smooth[k] = { t: smooth[k].t, f0: a + ((b - a) * (k - i + 1)) / (j - i + 1) };
    }
    i = j;
  }
  return smooth;
}

const semitones = (f, base) => 12 * Math.log2(f / base);

// Classify one syllable from points [{ x: 0..1 position, st: semitones from
// the speaker's middle }]. Thresholds are deliberately conservative.
export function classifyTone(points) {
  if (points.length < 6) return null;
  const n = points.length;
  const q = Math.max(2, Math.round(n / 4));
  const mean = (arr) => arr.reduce((s, p) => s + p.st, 0) / arr.length;
  const start = mean(points.slice(0, q));
  const end = mean(points.slice(n - q));
  let minP = points[0], maxP = points[0];
  for (const p of points) { if (p.st < minP.st) minP = p; if (p.st > maxP.st) maxP = p; }
  const level = mean(points);
  const delta = end - start;
  const riseAfterMin = end - minP.st;

  // 4th: a long fall that doesn't come back up. Checked before the 3rd,
  // since a 4th tone also ends low; in 4+4 the second one starts lower.
  if (delta <= -3 && minP.x > 0.6 && riseAfterMin < 1) return 4;
  // 2nd: ends clearly above where it started (often after a small early dip).
  if (delta >= 2 && end >= -0.5 && minP.x < 0.6) return 2;
  // 3rd: reaches low in the speaker's range, the low point not at the very
  // start; either dips and comes back up, or stays low and fairly flat.
  if (minP.st <= -2 && minP.x > 0.3 && start <= 2 &&
      (riseAfterMin >= 1 || (level <= -2 && Math.abs(delta) < 2.5))) return 3;
  // 1st: high and level.
  if (Math.abs(delta) < 1.5 && maxP.st - minP.st < 2.5 && level >= 0.5) return 1;
  return null;
}

// Split the word's pitch track into syllables using Azure's timing, then
// classify each. Azure's offsets count from its own stream start, which
// isn't ours, so they're anchored on the first voiced frame we heard.
// syllables: [{ char, pinyin, tone, offset, duration }] (offset/duration in s)
export function analyseWord(track, syllables, { baseline } = {}) {
  const voiced = track.filter((p) => p.f0 > 0);
  if (voiced.length < 8 || !syllables.length) return null;
  const sorted = voiced.map((p) => p.f0).sort((a, b) => a - b);
  const base = baseline || sorted[Math.floor(sorted.length * 0.5)];
  const onset = voiced[0].t;
  const lastVoiced = voiced[voiced.length - 1].t;
  const timed = syllables.every((s) => Number.isFinite(s.offset) && s.duration > 0);
  const az0 = timed ? syllables[0].offset : 0;
  const total = lastVoiced - onset;

  const out = syllables.map((s, i) => {
    let start, end;
    if (timed) {
      start = onset + (s.offset - az0);
      end = start + s.duration;
    } else {
      start = onset + (total * i) / syllables.length;
      end = onset + (total * (i + 1)) / syllables.length;
    }
    // Trim the edges, where consonants and the neighbours' tones bleed in.
    const pad = (end - start) * 0.12;
    const pts = track.filter((p) => p.f0 > 0 && p.t >= start + pad && p.t <= end - pad)
      .map((p) => ({ x: (p.t - start) / (end - start || 1), st: semitones(p.f0, base) }));
    return { ...s, start, end, contour: pts, heard: classifyTone(pts) };
  });
  return { baseline: base, onset, end: Math.max(lastVoiced, out[out.length - 1].end), syllables: out };
}

// Whether a heard tone counts as the expected one, allowing the standard
// changes in connected speech: 3+3 → the first is said as 2; a 3rd tone
// before another tone is often just low (heard as 3 anyway); 一 and 不
// change with their neighbours, so they're never judged.
export function toneMatches(expected, heard, next, char) {
  if (heard == null || expected === 5 || char === "一" || char === "不") return true;
  if (expected === heard) return true;
  // 3rd before another syllable: 3+3 becomes 2+3, and before other tones
  // it's often said with a slight rise.
  if (expected === 3 && next != null && heard === 2) return true;
  return false;
}

// What the app tells the learner: only when the pitch says a different tone
// AND Azure also found the syllable weak. Either signal alone is too noisy.
export const TONE_CLAIM_BELOW = 80;
export function toneVerdict(expected, heard, next, char, azureScore) {
  if (toneMatches(expected, heard, next, char)) return heard == null ? null : "ok";
  return azureScore != null && azureScore < TONE_CLAIM_BELOW ? "wrong" : null;
}

// Target shape for drawing, as [x, semitones] points (Chao tone letters:
// 55, 35, 214, 51, mapped onto roughly ±6 semitones).
export function toneTemplate(tone) {
  const lvl = (n) => (n - 3) * 3;
  switch (tone) {
    case 1: return [[0, lvl(5)], [1, lvl(5)]];
    case 2: return [[0, lvl(3)], [1, lvl(5)]];
    case 3: return [[0, lvl(2)], [0.55, lvl(1)], [1, lvl(4)]];
    case 4: return [[0, lvl(5)], [1, lvl(1)]];
    default: return [[0.3, lvl(2)], [0.7, lvl(2)]];
  }
}
