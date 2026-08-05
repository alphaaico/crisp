import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { mkdir, copyFile, readdir, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { spawn } from "node:child_process";
import { nanoid } from "nanoid";
import Groq from "groq-sdk";

const ROOT = process.cwd(),
  DATA = join(ROOT, "data"),
  UPLOADS = join(DATA, "uploads"),
  EXPORTS = join(DATA, "exports"),
  PROXIES = join(DATA, "proxies");
await Promise.all([
  mkdir(UPLOADS, { recursive: true }),
  mkdir(EXPORTS, { recursive: true }),
  mkdir(PROXIES, { recursive: true }),
]);
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/media", express.static(DATA));
const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 500 * 1024 * 1024 },
});
type Word = {
  id: string;
  text: string;
  start: number;
  end: number;
  filler_candidate: boolean;
  edit_state: "keep" | "suggested" | "deleted";
  // "acoustic" candidates weren't transcribed by the ASR at all — they were
  // inferred straight from the audio. Kept distinct so the UI can flag them
  // as unconfirmed instead of presenting them as a literal transcript word.
  source?: "asr" | "acoustic";
  // Only set for source: "acoustic" — the detector's own confidence (0-1).
  // Calibration puts real-world precision at this signal around 20%, so this
  // is for a human reviewer to triage with, not to threshold on blindly.
  confidence?: number;
};
type Project = {
  id: string;
  name: string;
  mediaPath: string;
  mediaUrl: string;
  kind: "audio" | "video";
  duration: number;
  words: Word[];
  operations: {
    id: string;
    type: "ripple_delete" | "mute";
    source_start: number;
    source_end: number;
    word_ids: string[];
    // "user_adjusted" means a human placed these boundaries on the waveform.
    // Automatic refinement is skipped for those — what was set is what gets
    // rendered, with no silent second-guessing.
    boundary_source?: "auto" | "user_adjusted";
  }[];
  finalized?: boolean;
  finalOutputPath?: string;
  finalOutputUrl?: string;
};
const projects = new Map<string, Project>();
const fillers = new Set([
  "um",
  "umm",
  "ummm",
  "uh",
  "uhh",
  "ah",
  "ahh",
  "erm",
  "er",
  "hmm",
  "hm",
]);
async function probe(file: string) {
  return new Promise<any>((resolve, reject) => {
    const p = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    let o = "";
    p.stdout.on("data", (d) => (o += d));
    p.on("close", (c) =>
      c === 0
        ? resolve(Number(o.trim()))
        : reject(new Error("Could not inspect media")),
    );
  });
}
function isVideo(path: string) {
  return [".mp4", ".mov", ".webm", ".mkv"].includes(
    extname(path).toLowerCase(),
  );
}
function run(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) =>
      c === 0 ? resolve() : reject(new Error(err.slice(-600))),
    );
  });
}
async function decodedAudioBuffer(file: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const p = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      file,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "s16le",
      "-",
    ]);
    let err = "";
    p.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    p.stderr.on("data", (chunk) => (err += chunk));
    p.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(err.slice(-600))),
    );
  });
}
// --- Acoustic filler detection, independent of any ASR provider ---
// Whisper (and ASR generally) frequently drops "um"/"uh" from the transcript
// text entirely, silently folding the filler's audio into a neighboring
// word's timestamp instead of giving it its own token. Text-matching against
// the transcript can only find a filler the ASR chose to write down, so it
// misses most of them on real (non-reference) media. This scans the actual
// decoded waveform for filler-shaped sound directly: a sustained,
// low-zero-crossing (voiced/nasal), energy-flat plateau bounded by short
// pauses on both sides. It never reads word text, so it works the same
// whether the transcript came from Groq, a different ASR engine, or nothing
// at all.
// Calibrated against a known-ground-truth recording (see project notes): energy
// + zero-crossing rate + envelope flatness cannot cleanly separate a filler
// from an ordinary unstressed vowel or nasal consonant in normal speech — the
// classes overlap too much in this feature space for thresholding alone.
// Best achievable on that calibration was ~20% precision at full recall; the
// numbers below sit deliberately on the low-recall, lower-noise side of that
// tradeoff, because a wrong "maybe" that a human reviews is fine but a firehose
// of them is not. Treat this as a best-effort supplementary hint, not a
// reliable detector — see the source-field comment on Word for how the UI is
// expected to gate on it (never auto-selected in bulk).
const FILLER_FRAME_HOP = 160; // 10ms at 16kHz
const FILLER_MIN_DURATION = 0.12;
const FILLER_MAX_DURATION = 0.7;
const FILLER_ENERGY_MIN_RATIO = 0.09; // relative to a robust local peak
const FILLER_ZCR_MAX = 0.16; // low zero-crossing rate => voiced/nasal, not fricative noise
const FILLER_FLATNESS_SCALE = 0.6; // cv=0 -> fully flat, cv>=scale -> not flat at all
const FILLER_BASE_MIN_CONFIDENCE = 0.55; // gate on the raw acoustic shape alone
const FILLER_FINAL_MIN_CONFIDENCE = 0.55; // gate after ASR-context adjustment
const SUSPICIOUS_LENGTH_FACTOR = 1.6;
const SUSPICIOUS_LENGTH_MARGIN = 0.15; // seconds

function frameFeatures(buffer: Buffer, hopSamples = FILLER_FRAME_HOP) {
  const sampleCount = Math.floor(buffer.length / 2);
  const frameCount = Math.floor(sampleCount / hopSamples);
  const energy = new Float64Array(frameCount);
  const zcr = new Float64Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    const offset = frame * hopSamples;
    let sumSquares = 0;
    let crossings = 0;
    let previous = buffer.readInt16LE(offset * 2);
    for (let i = 0; i < hopSamples; i++) {
      const value = buffer.readInt16LE((offset + i) * 2);
      sumSquares += (value / 32768) ** 2;
      if (i > 0 && value >= 0 !== previous >= 0) crossings++;
      previous = value;
    }
    energy[frame] = Math.sqrt(sumSquares / hopSamples);
    zcr[frame] = crossings / (hopSamples - 1);
  }
  return { energy, zcr };
}
function percentile(values: Float64Array, fraction: number) {
  if (!values.length) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(fraction * (sorted.length - 1))),
  );
  return sorted[index];
}
type AcousticRun = { start: number; end: number; confidence: number };
function findFillerShapedRuns(buffer: Buffer): AcousticRun[] {
  const { energy, zcr } = frameFeatures(buffer);
  if (!energy.length) return [];
  const peak = percentile(energy, 0.9) || 1;
  const energyThreshold = peak * FILLER_ENERGY_MIN_RATIO;
  const voiced = Array.from(
    { length: energy.length },
    (_, i) => energy[i] > energyThreshold && zcr[i] < FILLER_ZCR_MAX,
  );
  for (let i = 1; i < voiced.length - 1; i++) {
    if (!voiced[i] && voiced[i - 1] && voiced[i + 1]) voiced[i] = true;
  }
  const runs: AcousticRun[] = [];
  let runStart = -1;
  for (let i = 0; i <= voiced.length; i++) {
    const active = i < voiced.length && voiced[i];
    if (active && runStart === -1) runStart = i;
    if (!active && runStart !== -1) {
      const runEnd = i;
      const duration = ((runEnd - runStart) * FILLER_FRAME_HOP) / 16000;
      if (duration >= FILLER_MIN_DURATION && duration <= FILLER_MAX_DURATION) {
        const runEnergy = energy.slice(runStart, runEnd);
        const mean =
          runEnergy.reduce((total, value) => total + value, 0) /
          runEnergy.length;
        const variance =
          runEnergy.reduce((total, value) => total + (value - mean) ** 2, 0) /
          runEnergy.length;
        const cv = Math.sqrt(variance) / (mean || 1);
        const before = energy.slice(Math.max(0, runStart - 5), runStart);
        const after = energy.slice(runEnd, Math.min(energy.length, runEnd + 5));
        const surrounding = [...before, ...after];
        const surroundingMean = surrounding.length
          ? surrounding.reduce((total, value) => total + value, 0) /
            surrounding.length
          : mean;
        const dipStrength = Math.max(
          0,
          Math.min(1, 1 - surroundingMean / (mean || 1)),
        );
        // Flatness is a soft signal, not a hard gate: real fillers often have
        // a natural rise-decay envelope (indistinguishable from a single
        // real syllable by this measure alone), so gating on it hard drops
        // true positives without meaningfully improving precision.
        const flatness = Math.max(0, 1 - cv / FILLER_FLATNESS_SCALE);
        const confidence = Number((0.3 * flatness + 0.7 * dipStrength).toFixed(2));
        if (confidence >= FILLER_BASE_MIN_CONFIDENCE) {
          runs.push({
            start: (runStart * FILLER_FRAME_HOP) / 16000,
            end: (runEnd * FILLER_FRAME_HOP) / 16000,
            confidence,
          });
        }
      }
      runStart = -1;
    }
  }
  return runs;
}
function estimateCharRate(words: Word[]) {
  const samples = words
    .filter(
      (w) => !w.filler_candidate && w.text.replace(/[^a-zA-Z]/g, "").length >= 3,
    )
    .map((w) => (w.end - w.start) / w.text.replace(/[^a-zA-Z]/g, "").length)
    .sort((a, b) => a - b);
  if (!samples.length) return 0.065;
  return samples[Math.floor(samples.length / 2)];
}
function isSuspiciouslyLong(word: Word, charRate: number) {
  const chars = word.text.replace(/[^a-zA-Z]/g, "").length;
  const expected = Math.max(0.1, charRate * Math.max(2, chars));
  const actual = word.end - word.start;
  return (
    !word.filler_candidate &&
    actual > expected * SUSPICIOUS_LENGTH_FACTOR &&
    actual - expected > SUSPICIOUS_LENGTH_MARGIN
  );
}
// Runs the detector once over the whole file (cheap: one decode, one linear
// pass — no per-word re-decoding), then uses the ASR word list only as
// context to score each acoustic hit: a plateau mostly inside a normal-length
// word is probably that word's own vowel, not a swallowed filler, so it's
// dampened rather than dropped outright; a plateau inside a suspiciously
// long word or in a gap between words is exactly the "ASR silently absorbed
// the filler" shape, so it keeps full confidence.
async function detectAcousticFillerCandidates(
  mediaPath: string,
  words: Word[],
): Promise<Word[]> {
  const buffer = await decodedAudioBuffer(mediaPath);
  const runs = findFillerShapedRuns(buffer);
  const charRate = estimateCharRate(words);
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const candidates: Word[] = [];
  let syntheticIndex = 0;
  for (const run of runs) {
    const overlapping = sorted.filter(
      (word) => word.start < run.end && word.end > run.start,
    );
    if (overlapping.some((word) => word.filler_candidate)) continue;
    const runDuration = run.end - run.start;
    const overlapDuration = overlapping.reduce(
      (total, word) =>
        total +
        Math.max(0, Math.min(word.end, run.end) - Math.max(word.start, run.start)),
      0,
    );
    const overlapRatio = runDuration > 0 ? overlapDuration / runDuration : 0;
    const insideNormalWord =
      overlapRatio > 0.6 &&
      !overlapping.some((word) => isSuspiciouslyLong(word, charRate));
    const confidence = run.confidence * (insideNormalWord ? 0.3 : 1);
    if (confidence < FILLER_FINAL_MIN_CONFIDENCE) continue;
    syntheticIndex++;
    candidates.push({
      id: `word_ac_${String(syntheticIndex).padStart(4, "0")}`,
      text: "(filler?)",
      start: Number(run.start.toFixed(3)),
      end: Number(run.end.toFixed(3)),
      filler_candidate: true,
      edit_state: "suggested",
      source: "acoustic",
      confidence: Number(confidence.toFixed(2)),
    });
  }
  return candidates;
}
async function transcriptionProxy(project: Project) {
  const proxy = join(PROXIES, `${project.id}-16khz-mono.mp3`);
  if (!existsSync(proxy))
    await run("ffmpeg", [
      "-y",
      "-i",
      project.mediaPath,
      "-vn",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "48k",
      proxy,
    ]);
  return proxy;
}
// Whisper cleans up speech by default and drops disfluencies entirely — an
// unprompted pass over the sample returns zero fillers, silently folding them
// into the neighbouring word's timing. The prompt is used as a style prior
// rather than an instruction, so *demonstrating* disfluent speech works where
// describing it ("keep every um") mostly does not. Measured on the bundled
// samples: 0 fillers without it, all 3 with it, identical across repeated
// runs. It also improves the surrounding transcript (recovers the repeated
// "access access", and "Ellen" instead of "Alan"). Override with
// WHISPER_PROMPT to tune for a different speaker or language.
const FILLER_STYLE_PROMPT =
  process.env.WHISPER_PROMPT ??
  "Umm, so, like... uh, I mean, hmm, let me think. Uh, yeah, so basically, um, " +
    "it's like, you know, uh... hmm. Okay so, um, yeah.";
async function groqTranscribe(project: Project) {
  if (!process.env.GROQ_API_KEY)
    throw new Error(
      "GROQ_API_KEY is missing. Add it to .env, then restart the server.",
    );
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY }),
    proxy = await transcriptionProxy(project);
  // At 48 kbps each 15-minute chunk is about 5.4 MB, safely under Groq's request limit.
  const chunkSeconds = 900,
    overlapSeconds = 1,
    chunks: { path: string; offset: number }[] = [];
  for (let offset = 0, index = 0; offset < project.duration; index++) {
    const length = Math.min(chunkSeconds, project.duration - offset);
    if (project.duration <= chunkSeconds) {
      chunks.push({ path: proxy, offset: 0 });
      break;
    }
    const path = join(PROXIES, `${project.id}-chunk-${index}.mp3`);
    await run("ffmpeg", [
      "-y",
      "-ss",
      String(offset),
      "-t",
      String(length),
      "-i",
      proxy,
      "-c",
      "copy",
      path,
    ]);
    chunks.push({ path, offset });
    offset += chunkSeconds - overlapSeconds;
  }
  const sourceFs = await import("node:fs");
  const raw: { text: string; start: number; end: number }[] = [];
  for (const chunk of chunks) {
    const result: any = await groq.audio.transcriptions.create({
      file: sourceFs.createReadStream(chunk.path),
      model: "whisper-large-v3",
      response_format: "verbose_json",
      timestamp_granularities: ["word", "segment"],
      temperature: 0,
      prompt: FILLER_STYLE_PROMPT,
    });
    for (const word of result.words || []) {
      const text = String(word.word).trim(),
        item = {
          text,
          start: Number(word.start) + chunk.offset,
          end: Number(word.end) + chunk.offset,
        },
        previous = raw[raw.length - 1];
      if (
        previous &&
        previous.text.toLowerCase() === text.toLowerCase() &&
        Math.abs(previous.start - item.start) < 1.5
      )
        continue;
      raw.push(item);
    }
  }
  project.words = raw.map((w, i) => {
    // Whisper punctuates disfluencies like any other word ("uh," / "um,"), so
    // the raw token never matches the filler list — strip everything but the
    // letters before looking it up.
    const f = fillers.has(w.text.toLowerCase().replace(/[^a-z]/g, ""));
    return {
      id: `word_${String(i + 1).padStart(4, "0")}`,
      text: w.text,
      start: w.start,
      end: w.end,
      filler_candidate: f,
      edit_state: f ? ("suggested" as const) : ("keep" as const),
      source: "asr" as const,
    };
  });
  // The ASR text alone misses most fillers (see comment above the acoustic
  // detector) — supplement with candidates found directly in the waveform.
  const acousticCandidates = await detectAcousticFillerCandidates(
    project.mediaPath,
    project.words,
  );
  project.words = [...project.words, ...acousticCandidates].sort(
    (a, b) => a.start - b.start,
  );
}
// Convenience loader for the bundled sample file so testing does not require
// picking a file every time. It is an ordinary project in every other respect:
// no transcript comes with it, so it goes through real transcription like any
// other import.
async function demo() {
  const id = "demo";
  if (projects.has(id)) return projects.get(id)!;
  const source = join(ROOT, "Example Audio", "audio.mp3"),
    target = join(UPLOADS, "demo.mp3");
  if (!existsSync(source))
    throw new Error("Example Audio/audio.mp3 is missing.");
  if (!existsSync(target)) await copyFile(source, target);
  const project: Project = {
    id,
    name: "Crisp demo",
    mediaPath: target,
    mediaUrl: "/media/uploads/demo.mp3",
    kind: "audio",
    duration: await probe(target),
    words: [],
    operations: [],
  };
  projects.set(id, project);
  return project;
}
// Lets the landing page say up front whether transcription will actually
// work, instead of letting the user import a file and only find out when the
// transcribe call fails.
app.get("/api/status", (_req, res) =>
  res.json({
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    model: "whisper-large-v3",
  }),
);
app.get("/api/projects/demo", async (_req, res, next) => {
  try {
    res.json(await demo());
  } catch (e) {
    next(e);
  }
});
app.post(
  "/api/projects/upload",
  upload.single("media"),
  async (req, res, next) => {
    try {
      if (!req.file) throw new Error("Choose an audio or video file.");
      const ext = extname(req.file.originalname).toLowerCase();
      if (
        ![
          ".wav",
          ".mp3",
          ".m4a",
          ".aac",
          ".flac",
          ".ogg",
          ".webm",
          ".mp4",
          ".mov",
          ".mkv",
        ].includes(ext)
      )
        throw new Error("Unsupported media type.");
      const final = join(UPLOADS, `${req.file.filename}${ext}`);
      const { rename } = await import("node:fs/promises");
      await rename(req.file.path, final);
      const id = nanoid(10);
      const p: Project = {
        id,
        name: basename(req.file.originalname, ext),
        mediaPath: final,
        mediaUrl: `/media/uploads/${basename(final)}`,
        kind: isVideo(final) ? "video" : "audio",
        duration: await probe(final),
        words: [],
        operations: [],
      };
      projects.set(id, p);
      res.json(p);
    } catch (e) {
      next(e);
    }
  },
);
app.post("/api/projects/:id/transcribe", async (req, res, next) => {
  try {
    const p = projects.get(req.params.id);
    if (!p) throw new Error("Project not found");
    await groqTranscribe(p);
    res.json(p);
  } catch (e) {
    next(e);
  }
});
app.put("/api/projects/:id/edl", (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  p.operations = req.body.operations || [];
  res.json(p);
});
function mergeIntervals(intervals: [number, number][]) {
  const result: [number, number][] = [];
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    const prior = result[result.length - 1];
    if (prior && start <= prior[1] + 0.01) prior[1] = Math.max(prior[1], end);
    else result.push([Math.max(0, start), end]);
  }
  return result;
}
const BOUNDARY_SEARCH = 0.04; // seconds to search each side of a cut for a natural pause
const BOUNDARY_HOP = 160; // 10ms at 16kHz
function rmsEnvelope(buffer: Buffer, hopSamples = BOUNDARY_HOP) {
  const sampleCount = Math.floor(buffer.length / 2);
  const frameCount = Math.floor(sampleCount / hopSamples);
  const envelope = new Float64Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0;
    const offset = frame * hopSamples;
    for (let i = 0; i < hopSamples; i++) {
      const value = buffer.readInt16LE((offset + i) * 2) / 32768;
      sum += value * value;
    }
    envelope[frame] = Math.sqrt(sum / hopSamples);
  }
  return envelope;
}
function zcrEnvelope(buffer: Buffer, hopSamples = BOUNDARY_HOP) {
  const sampleCount = Math.floor(buffer.length / 2);
  const frameCount = Math.floor(sampleCount / hopSamples);
  const zcr = new Float64Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    const offset = frame * hopSamples;
    let crossings = 0;
    let previous = buffer.readInt16LE(offset * 2);
    for (let i = 1; i < hopSamples; i++) {
      const value = buffer.readInt16LE((offset + i) * 2);
      if (value >= 0 !== previous >= 0) crossings++;
      previous = value;
    }
    zcr[frame] = crossings / (hopSamples - 1);
  }
  return zcr;
}
function smoothEnvelope(envelope: Float64Array, radius = 2) {
  const out = new Float64Array(envelope.length);
  for (let i = 0; i < envelope.length; i++) {
    let sum = 0,
      count = 0;
    for (
      let j = Math.max(0, i - radius);
      j <= Math.min(envelope.length - 1, i + radius);
      j++
    ) {
      sum += envelope[j];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}
// Finds the true edge of the quiet stretch containing anchorFrame, within
// [fromFrame, toFrame]. A breath, trailing consonant, or silence are all
// much quieter than real speech, so they're classified as one "quiet" zone
// together — an earlier attempt tried to find where loud content resumes by
// requiring several consecutive loud frames, but a word's own ending
// naturally tapers off, so that search kept walking backward past the taper
// into the word's core, eating real content.
//
// Energy alone still isn't enough, though: a nasal consonant like the "n"
// that opens "in" is quiet but still *voiced* — periodic, low
// zero-crossing-rate — unlike true silence or an unvoiced breath, which are
// aperiodic. Without checking that, a quiet-run search can walk straight
// through a word's soft onset thinking it's still part of the silence
// before it. So a frame only counts as safely-quiet if it's either close to
// true silence outright, or quiet *and* not showing that voiced signature.
const QUIET_RATIO = 0.12; // fraction of local peak below which a frame counts as quiet
const NEAR_SILENCE_RATIO = 0.04; // below this, treat as silence regardless of voicing
const VOICED_ZCR_MAX = 0.15; // low zero-crossing rate => voiced (vowel/nasal), not silence/noise
function quietRunEdge(
  envelope: Float64Array,
  zcr: Float64Array,
  fromFrame: number,
  toFrame: number,
  anchorFrame: number,
  direction: 1 | -1,
) {
  const lo = Math.max(0, Math.min(fromFrame, toFrame));
  const hi = Math.min(envelope.length - 1, Math.max(fromFrame, toFrame));
  const anchor = Math.max(lo, Math.min(hi, anchorFrame));
  if (hi < lo) return anchor;
  let peak = 0;
  for (let i = lo; i <= hi; i++) peak = Math.max(peak, envelope[i]);
  const threshold = (peak || 1) * QUIET_RATIO;
  const silenceThreshold = (peak || 1) * NEAR_SILENCE_RATIO;
  const quiet = (i: number) => {
    if (envelope[i] < silenceThreshold) return true; // true silence either way
    const voiced = zcr[i] < VOICED_ZCR_MAX;
    return envelope[i] < threshold && !voiced;
  };
  // Start from the anchor's own quiet/loud state — if the anchor itself
  // isn't quiet (a mistimed selection sitting on real content), walk in the
  // search direction until we do find quiet, then continue from there.
  let i = anchor;
  while (i >= lo && i <= hi && !quiet(i)) i += direction;
  if (i < lo || i > hi) return anchor;
  // Now walk to the far edge of this contiguous quiet run.
  let edge = i;
  while (i >= lo && i <= hi && quiet(i)) {
    edge = i;
    i += direction;
  }
  return edge;
}
async function decodeWindow(
  file: string,
  windowStart: number,
  windowLength: number,
) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const p = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(Math.max(0, windowStart)),
      "-t",
      String(windowLength),
      "-i",
      file,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "s16le",
      "-",
    ]);
    let err = "";
    p.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    p.stderr.on("data", (chunk) => (err += chunk));
    p.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(err.slice(-300))),
    );
  });
}
// Word-level transcript timestamps (reference or ASR) are approximate: a
// selected word's marked edge can overlap the tail of the previous word or
// the head of the next one. Rather than trust that edge exactly, decode a
// small window of the actual source audio around it and snap the cut to the
// nearest natural pause, so the removal completes fully without biting into
// a neighbor. This runs inside the one shared render path for every
// operation (filler or not, remove or silence), so every caller gets it
// automatically regardless of which transcript produced the boundary.
async function refineOperationBounds(
  p: Project,
  operations: Project["operations"],
) {
  return Promise.all(
    operations.map(async (operation) => {
      // A boundary the user placed by hand on the waveform is the answer, not
      // a suggestion to be re-derived — leave it exactly as given.
      if (operation.boundary_source === "user_adjusted") return operation;
      const windowStart = Math.max(0, operation.source_start - BOUNDARY_SEARCH);
      const windowEnd = Math.min(
        p.duration,
        operation.source_end + BOUNDARY_SEARCH,
      );
      if (windowEnd - windowStart < 0.05) return operation;
      try {
        const buffer = await decodeWindow(
          p.mediaPath,
          windowStart,
          windowEnd - windowStart,
        );
        const envelope = smoothEnvelope(rmsEnvelope(buffer));
        const zcr = zcrEnvelope(buffer);
        const toFrame = (t: number) =>
          Math.round(((t - windowStart) * 16000) / BOUNDARY_HOP);
        const toTime = (frame: number) =>
          windowStart + (frame * BOUNDARY_HOP) / 16000;
        // Start boundary: back edge of the quiet run the selection starts
        // in — everything from there up to the selection was already quiet
        // (silence, breath, trailing consonant) and is fair game to remove.
        const startFrame = quietRunEdge(
          envelope,
          zcr,
          0,
          toFrame(operation.source_start + 0.05),
          toFrame(operation.source_start),
          -1,
        );
        // End boundary: forward edge of the quiet run the selection ends
        // in, so the cut extends all the way up to where real speech
        // resumes instead of stopping at a brief quiet dip mid-breath.
        const endFrame = quietRunEdge(
          envelope,
          zcr,
          toFrame(operation.source_end - 0.05),
          envelope.length - 1,
          toFrame(operation.source_end),
          1,
        );
        const refinedStart = toTime(startFrame);
        const refinedEnd = toTime(endFrame);
        if (refinedEnd - refinedStart < 0.03) return operation;
        return {
          ...operation,
          source_start: Number(refinedStart.toFixed(3)),
          source_end: Number(refinedEnd.toFixed(3)),
        };
      } catch {
        return operation;
      }
    }),
  );
}
async function createEditedPreview(p: Project, operations = p.operations) {
  const refinedOperations = await refineOperationBounds(p, operations);
  const removed = mergeIntervals(
    refinedOperations
      .filter((o) => o.type === "ripple_delete")
      .map((o) => [o.source_start, o.source_end] as [number, number]),
  );
  const muted = mergeIntervals(
    refinedOperations
      .filter((o) => o.type === "mute")
      .map((o) => [o.source_start, o.source_end] as [number, number]),
  );
  const kept: [number, number][] = [];
  let cursor = 0;
  for (const [start, end] of removed) {
    if (start > cursor) kept.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < p.duration) kept.push([cursor, p.duration]);
  if (!kept.length)
    throw new Error(
      "The current edit removes all media. Restore an edit before previewing.",
    );
  const out = `${p.id}-preview-${Date.now()}.${p.kind === "video" ? "mp4" : "mp3"}`,
    output = join(EXPORTS, out);
  const MUTE_FADE = 0.015; // seconds; ramps into/out of silence instead of a hard gate
  const chains = kept
    .map(([start, end], index) => {
      const silences = muted
        .filter(([mStart, mEnd]) => mStart < end && mEnd > start)
        .map(([mStart, mEnd]) => {
          const a = Math.max(0, mStart - start).toFixed(4);
          const b = Math.min(end - start, mEnd - start).toFixed(4);
          const fadeInStart = (Number(a) - MUTE_FADE).toFixed(4);
          const fadeOutEnd = (Number(b) + MUTE_FADE).toFixed(4);
          return `volume=eval=frame:volume='if(lt(t,${fadeInStart}),1,if(lt(t,${a}),(${a}-t)/${MUTE_FADE},if(lt(t,${b}),0,if(lt(t,${fadeOutEnd}),(t-${b})/${MUTE_FADE},1))))'`;
        })
        .join(",");
      // Ripple cuts butt two unrelated moments of audio together with no
      // crossfade, which can click and clip the coarticulation into the next
      // word. A short de-click fade at each internal splice (not at the
      // media's true start/end) smooths the join without touching content.
      const fadeLength = Math.min(0.012, (end - start) / 4);
      const fadeIn =
        index > 0 ? `,afade=t=in:st=0:d=${fadeLength.toFixed(4)}` : "";
      const fadeOut =
        index < kept.length - 1
          ? `,afade=t=out:st=${Math.max(0, end - start - fadeLength).toFixed(4)}:d=${fadeLength.toFixed(4)}`
          : "";
      const audio = `[0:a]atrim=${start}:${end},asetpts=PTS-STARTPTS${fadeIn}${fadeOut}${silences ? "," + silences : ""}[a${index}]`;
      return p.kind === "video"
        ? `[0:v]trim=${start}:${end},setpts=PTS-STARTPTS[v${index}];${audio}`
        : audio;
    })
    .join(";");
  const inputPads = kept
    .map((_, i) => (p.kind === "video" ? `[v${i}][a${i}]` : `[a${i}]`))
    .join("");
  const filter = `${chains};${inputPads}concat=n=${kept.length}:v=${p.kind === "video" ? 1 : 0}:a=1${p.kind === "video" ? "[v][a]" : "[a]"}`;
  await run("ffmpeg", [
    "-y",
    "-i",
    p.mediaPath,
    "-filter_complex",
    filter,
    ...(p.kind === "video" ? ["-map", "[v]", "-map", "[a]"] : ["-map", "[a]"]),
    output,
  ]);
  return {
    url: `/media/exports/${out}`,
    duration: kept.reduce((total, [start, end]) => total + end - start, 0),
  };
}
app.post("/api/projects/:id/preview", async (req, res, next) => {
  try {
    const p = projects.get(req.params.id);
    if (!p) throw new Error("Project not found");
    const operations = req.body?.operations ?? p.operations ?? [];
    if (!operations.length)
      return res.json({ url: p.mediaUrl, duration: p.duration });
    res.json(await createEditedPreview(p, operations));
  } catch (e) {
    next(e);
  }
});
// Downsampled peaks for the boundary editor's waveform. Transcript
// timestamps are only ever a starting guess, so the user needs to see the
// actual audio to place a cut — this is what the drag handles sit on top of.
app.get("/api/projects/:id/waveform", async (req, res, next) => {
  try {
    const p = projects.get(req.params.id);
    if (!p) throw new Error("Project not found");
    const start = Math.max(0, Number(req.query.start) || 0);
    const end = Math.min(p.duration, Number(req.query.end) || p.duration);
    const bins = Math.min(2000, Math.max(50, Number(req.query.bins) || 600));
    if (end - start < 0.01) throw new Error("Invalid waveform range");
    const buffer = await decodeWindow(p.mediaPath, start, end - start);
    const sampleCount = Math.floor(buffer.length / 2);
    const perBin = Math.max(1, Math.floor(sampleCount / bins));
    const peaks: number[] = [];
    for (let bin = 0; bin < bins; bin++) {
      const offset = bin * perBin;
      if (offset >= sampleCount) break;
      let max = 0;
      for (let i = 0; i < perBin && offset + i < sampleCount; i++) {
        const value = Math.abs(buffer.readInt16LE((offset + i) * 2)) / 32768;
        if (value > max) max = value;
      }
      peaks.push(Number(max.toFixed(4)));
    }
    res.json({ start, end, peaks });
  } catch (e) {
    next(e);
  }
});
async function cleanProjectMedia(p: Project, keep: string) {
  const files = [
    ...(await readdir(PROXIES)).map((name) => join(PROXIES, name)),
    ...(await readdir(EXPORTS)).map((name) => join(EXPORTS, name)),
  ];
  await Promise.all([
    rm(p.mediaPath, { force: true }),
    ...files
      .filter((path) => path !== keep && basename(path).startsWith(`${p.id}-`))
      .map((path) => rm(path, { force: true })),
  ]);
  p.finalized = true;
}
app.post("/api/projects/:id/finalize", async (req, res, next) => {
  try {
    const p = projects.get(req.params.id);
    if (!p) throw new Error("Project not found");
    if (p.finalized)
      return res.json({
        url: p.finalOutputUrl,
        downloadUrl: `/api/projects/${p.id}/download`,
        finalized: true,
      });
    const operations = req.body?.operations ?? p.operations ?? [];
    if (!operations.length)
      throw new Error(
        "Select at least one word before preparing the final download.",
      );
    const preview = await createEditedPreview(p, operations);
    p.operations = operations;
    p.finalOutputUrl = preview.url;
    p.finalOutputPath = join(DATA, preview.url.replace("/media/", ""));
    p.finalized = true;
    res.json({
      ...preview,
      downloadUrl: `/api/projects/${p.id}/download`,
      finalized: true,
    });
  } catch (e) {
    next(e);
  }
});
app.get("/api/projects/:id/download", async (req, res, next) => {
  const p = projects.get(req.params.id);
  if (!p?.finalOutputPath)
    return res.status(404).json({ error: "Prepare the final download first." });
  res.download(
    p.finalOutputPath,
    `${p.name}-crisp-final${extname(p.finalOutputPath)}`,
    async (error) => {
      if (error) return next(error);
      await cleanProjectMedia(p, p.finalOutputPath!);
    },
  );
});
app.post("/api/projects/:id/render", async (req, res, next) => {
  try {
    const p = projects.get(req.params.id);
    if (!p) throw new Error("Project not found");
    const mode = req.body?.mode as "ripple" | "mute" | undefined;
    const requestedOperations = req.body?.operations ?? p.operations ?? [];
    const operations = mode
      ? requestedOperations.filter(
          (operation: Project["operations"][number]) =>
            mode === "mute"
              ? operation.type === "mute"
              : operation.type === "ripple_delete",
        )
      : requestedOperations;
    if (!operations.length) throw new Error("No edits to render.");
    const result = await createEditedPreview(p, operations);
    res.json({ ...result, filename: basename(result.url) });
  } catch (e) {
    next(e);
  }
});
app.use((err: any, _req: any, res: any, _next: any) =>
  res.status(400).json({ error: err.message || "Processing failed" }),
);
app.listen(Number(process.env.PORT) || 8787, () =>
  console.log("Crisp API on http://localhost:8787"),
);
