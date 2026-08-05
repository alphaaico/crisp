import { useEffect, useMemo, useRef, useState } from "react";
import BoundaryEditor, { type Bounds } from "./BoundaryEditor";
import { WHISPER_LANGUAGES } from "./languages";

type Word = {
  id: string;
  text: string;
  start: number;
  end: number;
  filler_candidate: boolean;
  edit_state: string;
  source?: "asr" | "acoustic";
  confidence?: number;
};

type Op = {
  id: string;
  type: "ripple_delete" | "mute";
  source_start: number;
  source_end: number;
  word_ids: string[];
  // Tells the renderer whether these bounds were hand-placed on the waveform.
  // User-adjusted operations skip the server's automatic boundary refinement.
  boundary_source: "auto" | "user_adjusted";
};

type Project = {
  id: string;
  name: string;
  mediaUrl: string;
  kind: "audio" | "video";
  duration: number;
  words: Word[];
  operations: Op[];
  finalized?: boolean;
};

type PreviewMode = "original" | "silence" | "cut";

const api = async (path: string, init?: RequestInit) => {
  const response = await fetch(path, init);
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Request failed");
  return data;
};

const fmt = (t: number) =>
  `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const precise = (t: number) => `${t.toFixed(3)}s`;

const mergeIntervals = (intervals: [number, number][]) => {
  const merged: [number, number][] = [];
  for (const [start, end] of intervals
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0])) {
    const prior = merged.at(-1);
    if (prior && start <= prior[1] + 0.01) prior[1] = Math.max(prior[1], end);
    else merged.push([start, end]);
  }
  return merged;
};

// A waveform interrupted by a cut, which is what the editor does. Drawn
// inline so it scales cleanly and takes its colour from CSS — the previous
// mark was a generic stock "timeline" icon tinted with a filter hack.
const CrispMark = () => (
  <svg className="brand-mark" viewBox="0 0 30 24" aria-hidden="true">
    {[
      [1, 3.5],
      [4.6, 7],
      [8.2, 10],
      [17.4, 8.5],
      [21, 5.5],
      [24.6, 3],
    ].map(([x, half]) => (
      <rect
        key={x}
        x={x}
        y={12 - half}
        width="2.6"
        height={half * 2}
        rx="1.3"
      />
    ))}
    <path className="brand-seam" d="M14 4v16" />
  </svg>
);

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("original");
  const [previewDuration, setPreviewDuration] = useState<number | null>(null);
  const [previewOps, setPreviewOps] = useState<Op[]>([]);
  const [editType, setEditType] = useState<Op["type"]>("ripple_delete");
  const [downloadUrl, setDownloadUrl] = useState("");
  // User-adjusted cut boundaries, keyed by word id and kept separate from the
  // transcript's own timestamps — the transcript stays a suggestion, and a
  // hand-placed boundary always wins over the automatic one.
  const [adjusted, setAdjusted] = useState<Record<string, Bounds>>({});
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // Acoustic guesses are mostly wrong (see Word.source) and there can be a
  // dozen of them, so they stay out of the transcript unless asked for —
  // otherwise they shred the sentence you are trying to read.
  const [showDetected, setShowDetected] = useState(false);
  const [status, setStatus] = useState<{ groqConfigured: boolean } | null>(
    null,
  );
  const player = useRef<HTMLAudioElement | HTMLVideoElement>(null);

  const mediaSrc = previewUrl || project?.mediaUrl || "";
  const duration = previewDuration ?? project?.duration ?? 0;
  const cutIntervals = useMemo(
    () =>
      mergeIntervals(
        previewOps
          .filter((op) => op.type === "ripple_delete")
          .map((op) => [op.source_start, op.source_end] as [number, number]),
      ),
    [previewOps],
  );

  const keptIntervals = useMemo(() => {
    if (!project) return [] as [number, number][];
    const kept: [number, number][] = [];
    let cursor = 0;
    for (const [start, end] of cutIntervals) {
      if (start > cursor) kept.push([cursor, start]);
      cursor = Math.max(cursor, end);
    }
    if (cursor < project.duration) kept.push([cursor, project.duration]);
    return kept;
  }, [project, cutIntervals]);

  useEffect(() => {
    if (!project) return;
    setEditType(project.kind === "video" ? "mute" : "ripple_delete");
  }, [project?.id, project?.kind]);

  useEffect(() => {
    fetch("/api/status")
      .then((response) => response.json())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  const clearPreview = () => {
    setPreviewUrl("");
    setPreviewMode("original");
    setPreviewDuration(null);
    setPreviewOps([]);
    setDownloadUrl("");
  };

  const playbackToSource = (time: number) => {
    if (previewMode !== "cut") return time;
    let outputCursor = 0;
    for (const [start, end] of keptIntervals) {
      const length = end - start;
      if (time <= outputCursor + length) return start + (time - outputCursor);
      outputCursor += length;
    }
    return project?.duration ?? time;
  };

  const sourceToPlayback = (time: number) => {
    if (previewMode !== "cut") return time;
    let removedBefore = 0;
    for (const [start, end] of cutIntervals) {
      if (time >= start && time < end) return null;
      if (end <= time) removedBefore += end - start;
    }
    return time - removedBefore;
  };

  const sourceCurrent = playbackToSource(current);
  // "Spoken now" follows the real transcript only — an acoustic guess is not
  // a word anyone said, so it should never show up as the current one.
  const spoken =
    project?.words.filter((word) => word.source !== "acoustic") ?? [];
  const active = spoken.find(
    (word) => sourceCurrent >= word.start && sourceCurrent < word.end,
  )?.id;
  const activeIndex = spoken.findIndex((word) => word.id === active);
  const contextWords = spoken.slice(
    Math.max(0, activeIndex - 5),
    Math.max(0, activeIndex - 5) + 11,
  );

  const selectedWords = project
    ? project.words
        .filter((word) => selected.includes(word.id))
        .sort((a, b) => a.start - b.start)
    : [];

  // Where the cut would land with no human input — the starting position for
  // the drag handles, not the final answer.
  const defaultBounds = (word: Word, type = editType): Bounds => {
    // An acoustic candidate is a span found in the waveform precisely because
    // the transcript has nothing there. Clamping it to the surrounding ASR
    // word boundaries would squeeze it against the very timings it exists to
    // work around — often down to nothing — so its detected span is used as-is.
    if (word.source === "acoustic") return { start: word.start, end: word.end };
    const fillerEdit =
      word.filler_candidate && (type === "mute" || type === "ripple_delete");
    if (fillerEdit && project) {
      const index = project.words.findIndex(
        (candidate) => candidate.id === word.id,
      );
      const previous = index > 0 ? project.words[index - 1] : null;
      const next = index >= 0 ? project.words[index + 1] : null;
      return {
        start: Math.max(0, previous?.end ?? 0, word.start - 0.12),
        end: Math.min(
          project.duration,
          next?.start ?? project.duration,
          word.end + 0.12,
        ),
      };
    }
    return {
      start: Math.max(0, word.start),
      end: word.end,
    };
  };

  const editBounds = (word: Word, type = editType): Bounds =>
    adjusted[word.id] ?? defaultBounds(word, type);

  const plannedRanges = selectedWords.map((word) => ({
    word,
    ...editBounds(word),
  }));

  const makeOperations = (type = editType): Op[] =>
    selectedWords.map((word) => ({
      id: crypto.randomUUID(),
      type,
      source_start: editBounds(word, type).start,
      source_end: editBounds(word, type).end,
      word_ids: [word.id],
      boundary_source: adjusted[word.id] ? "user_adjusted" : "auto",
    }));

  // The transcript reads as prose from the ASR words alone. Acoustic guesses
  // are woven back in as slim markers sitting between the words they fall
  // between, so they keep their position without becoming pseudo-words.
  const detectedWords =
    project?.words.filter((word) => word.source === "acoustic") ?? [];
  const transcriptItems = (() => {
    const items: { marker: boolean; word: Word }[] = [];
    let pending = 0;
    for (const word of spoken) {
      while (
        showDetected &&
        pending < detectedWords.length &&
        detectedWords[pending].start < word.start
      )
        items.push({ marker: true, word: detectedWords[pending++] });
      items.push({ marker: false, word });
    }
    while (showDetected && pending < detectedWords.length)
      items.push({ marker: true, word: detectedWords[pending++] });
    return items;
  })();

  const focusedIndex = selectedWords.findIndex((word) => word.id === focusedId);
  const focusedWord = focusedIndex >= 0 ? selectedWords[focusedIndex] : null;
  const focusedNeighbours = (() => {
    if (!project || !focusedWord) return { previous: null, next: null };
    const index = project.words.findIndex((word) => word.id === focusedWord.id);
    return {
      previous: index > 0 ? project.words[index - 1] : null,
      next:
        index >= 0 && index < project.words.length - 1
          ? project.words[index + 1]
          : null,
    };
  })();
  // Moving a boundary makes any rendered preview stale, but dragging fires
  // constantly — only reset when there is actually a preview to invalidate.
  const invalidatePreview = () => {
    if (previewUrl) clearPreview();
  };

  const seekToWord = (word: Word) => {
    const target = sourceToPlayback(word.start);
    if (target === null || !player.current) return;
    player.current.currentTime = target;
  };

  const toggleWord = (word: Word) => {
    clearPreview();
    seekToWord(word);
    const wasSelected = selected.includes(word.id);
    const next = wasSelected
      ? selected.filter((id) => id !== word.id)
      : [...selected, word.id];
    setSelected(next);
    // Selecting a word opens its boundary editor; deselecting the focused one
    // hands focus to whatever is still selected.
    if (!wasSelected) setFocusedId(word.id);
    else if (focusedId === word.id) setFocusedId(next[0] ?? null);
  };

  const selectFillers = () => {
    if (!project) return;
    clearPreview();
    const ids = project.words
      // Acoustic candidates are a best-effort guess with a real false-positive
      // rate (see Word.source) — never bulk-select them. They're still
      // individually clickable in the transcript for manual review.
      .filter((word) => word.filler_candidate && word.source !== "acoustic")
      .map((word) => word.id);
    setSelected(ids);
    setFocusedId(ids[0] ?? null);
  };

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setError("");
      setBusy("Importing media...");
      setProject(null);
      setSelected([]);
      setFocusedId(null);
      setAdjusted({});
      clearPreview();
      const body = new FormData();
      body.append("media", file);
      const imported = await api("/api/projects/upload", {
        method: "POST",
        body,
      });
      setProject(imported);
      setEditType(imported.kind === "video" ? "mute" : "ripple_delete");
      setBusy("Transcribing...");
      setProject(
        await api(`/api/projects/${imported.id}/transcribe`, {
          method: "POST",
        }),
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
      event.currentTarget.value = "";
    }
  };

  const openSampleAudio = async () => {
    try {
      setError("");
      setBusy("Opening sample audio...");
      setSelected([]);
      setFocusedId(null);
      setAdjusted({});
      clearPreview();
      const sample = await api("/api/projects/demo");
      setProject(sample);
      // The sample ships with no transcript of its own — transcribe it the
      // same way an imported file would be.
      if (!sample.words.length) {
        setBusy("Transcribing...");
        setProject(
          await api(`/api/projects/${sample.id}/transcribe`, {
            method: "POST",
          }),
        );
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const transcribe = async () => {
    if (!project) return;
    try {
      setError("");
      setBusy("Transcribing...");
      // A fresh transcript renumbers every word, so ids from the old one no
      // longer refer to the same audio — carrying selections or hand-placed
      // boundaries across would silently apply them to the wrong words.
      setSelected([]);
      setFocusedId(null);
      setAdjusted({});
      setProject(
        await api(`/api/projects/${project.id}/transcribe`, { method: "POST" }),
      );
      clearPreview();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const previewSelection = async () => {
    if (!project) return;
    const operations = makeOperations();
    if (!operations.length) return;
    try {
      setError("");
      setBusy("Rendering preview from original...");
      const data = await api(`/api/projects/${project.id}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operations }),
      });
      setPreviewUrl(data.url);
      setPreviewDuration(data.duration);
      setPreviewOps(operations);
      setPreviewMode(editType === "mute" ? "silence" : "cut");
      setCurrent(0);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const prepareDownload = async () => {
    if (!project) return;
    const operations = makeOperations();
    if (!operations.length) return;
    try {
      setError("");
      setBusy("Preparing final file...");
      const data = await api(`/api/projects/${project.id}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operations }),
      });
      setPreviewUrl(data.url);
      setPreviewDuration(data.duration);
      setPreviewOps(operations);
      setPreviewMode(editType === "mute" ? "silence" : "cut");
      setDownloadUrl(data.downloadUrl);
      setProject({ ...project, finalized: true });
      setCurrent(0);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  return (
    <main>
      <header>
        <div className="brand">
          <CrispMark />
          <span>crisp</span>
        </div>
        <div className="status">
          {project ? `${project.kind.toUpperCase()} EDITOR` : "READY"}
          <i />
          {previewMode === "original" ? "original" : `${previewMode} preview`}
        </div>
        <label className="import">
          Import media
          <input type="file" accept="audio/*,video/*" onChange={upload} />
        </label>
      </header>

      {!project ? (
        <section className="empty-state">
          <div>
            <p className="eyebrow">START</p>
            <h1>Edit audio and video by editing the transcript</h1>
            <p className="lede">
              Import a file, and Crisp transcribes it into words you can click.
              Pick the ones to cut, fine-tune each cut on the waveform, then
              export. Your original file is never modified.
            </p>

            <div className="empty-actions">
              <label className="import large">
                Import media
                <input type="file" accept="audio/*,video/*" onChange={upload} />
              </label>
              <button onClick={openSampleAudio}>Try the sample audio</button>
            </div>

            {status && !status.groqConfigured && (
              <div className="setup-warning">
                <strong>No Groq API key found</strong>
                <p>
                  Transcription will fail without one. Create a key at{" "}
                  <code>console.groq.com</code>, then add it to a{" "}
                  <code>.env</code> file in the project root and restart:
                </p>
                <pre>GROQ_API_KEY=your_key_here</pre>
              </div>
            )}

            <div className="guide">
              <div className="guide-step">
                <b>1</b>
                <div>
                  <strong>Import</strong>
                  <span>
                    Audio or video. Video keeps its picture — Crisp only pulls
                    the audio out to transcribe it.
                  </span>
                </div>
              </div>
              <div className="guide-step">
                <b>2</b>
                <div>
                  <strong>Select words</strong>
                  <span>
                    Click any word to mark it for removal. “Select fillers”
                    grabs every <em>um</em>, <em>uh</em> and <em>hmm</em>
                    {" at once."}
                  </span>
                </div>
              </div>
              <div className="guide-step">
                <b>3</b>
                <div>
                  <strong>Adjust the cut</strong>
                  <span>
                    Transcript timings are approximate, so each cut opens on a
                    waveform. Play the selection to hear exactly what gets
                    removed, and drag the edges until it is right.
                  </span>
                </div>
              </div>
              <div className="guide-step">
                <b>4</b>
                <div>
                  <strong>Preview and export</strong>
                  <span>
                    Audio is cut and closed up. Video can also be silenced in
                    place, which leaves the picture and timing untouched.
                  </span>
                </div>
              </div>
            </div>

            <details className="languages">
              <summary>
                Transcription runs on Whisper large-v3 via Groq —{" "}
                {WHISPER_LANGUAGES.length} languages supported
              </summary>
              <p className="languages-note">
                Accuracy varies a lot between these. Also note the filler-word
                detection is primed with English disfluencies, so for another
                language you will want to set <code>WHISPER_PROMPT</code> in{" "}
                <code>.env</code> to a sample of filler speech in that language.
              </p>
              <div className="languages-list">
                {WHISPER_LANGUAGES.map((language) => (
                  <span key={language}>{language}</span>
                ))}
              </div>
            </details>

            <p className="requires">
              Requires FFmpeg and FFprobe on your <code>PATH</code>.
            </p>
          </div>
        </section>
      ) : (
        <>
          <section className="workspace">
            <aside>
              <p className="eyebrow">PROJECT</p>
              <h1>{project.name}</h1>
              <div className="meta">
                {project.kind} · {fmt(project.duration)}
              </div>
              <hr />
              <p className="eyebrow">TRANSCRIPT</p>
              <button
                className="scan"
                onClick={transcribe}
                disabled={Boolean(busy) || project.finalized}
              >
                {project.words.length ? "Re-transcribe" : "Transcribe"}
              </button>
              <div className="counts">
                <b>
                  {
                    project.words.filter(
                      (word) => word.filler_candidate && word.source !== "acoustic",
                    ).length
                  }
                </b>
                <span>filler suggestions</span>
              </div>
              {detectedWords.length > 0 && (
                <label className="detected-toggle">
                  <input
                    type="checkbox"
                    checked={showDetected}
                    onChange={(event) => {
                      const next = event.currentTarget.checked;
                      setShowDetected(next);
                      // Hidden means out of play — drop any that were picked,
                      // so nothing invisible ends up in the render.
                      if (!next) {
                        const ids = new Set(detectedWords.map((w) => w.id));
                        setSelected((existing) =>
                          existing.filter((id) => !ids.has(id)),
                        );
                        if (focusedId && ids.has(focusedId)) setFocusedId(null);
                      }
                    }}
                  />
                  <span>
                    Show {detectedWords.length} possible fillers found in the
                    audio but not transcribed. These are rough guesses — check
                    each one.
                  </span>
                </label>
              )}
              <div className="counts">
                <b>{selected.length}</b>
                <span>selected words</span>
              </div>
            </aside>

            <section className="editor">
              <div className="mode-bar">
                <div>
                  <span className="eyebrow">MEDIA</span>
                  <strong>
                    {previewMode === "original"
                      ? "Original source"
                      : previewMode === "silence"
                        ? "Preview with selected words silenced"
                        : "Preview with selected words removed"}
                  </strong>
                  {/* The editor has no audio/video toggle — the mode follows
                      whatever was imported. Said plainly here so it does not
                      look like a setting someone failed to find. */}
                  <div className="kind-line">
                    <span className={`kind-badge ${project.kind}`}>
                      {project.kind === "video" ? "VIDEO" : "AUDIO"}
                    </span>
                    <span>
                      {project.kind === "video"
                        ? "Silence and Remove both available. Import an audio file to switch to the audio editor."
                        : "Remove only — silencing audio just leaves a gap. Import a video file to switch to the video editor."}
                    </span>
                  </div>
                  <code className="media-source">
                    {previewUrl
                      ? `generated copy: ${previewUrl}`
                      : `original upload: ${project.mediaUrl}`}
                  </code>
                </div>
                {previewMode !== "original" && (
                  <button onClick={clearPreview}>Back to original</button>
                )}
              </div>

              <div className={`media ${project.kind}`}>
                {project.kind === "video" ? (
                  <video
                    key={mediaSrc}
                    ref={player as any}
                    src={mediaSrc}
                    controls
                    autoPlay={previewMode !== "original"}
                    onTimeUpdate={(event) =>
                      setCurrent(event.currentTarget.currentTime)
                    }
                  />
                ) : (
                  <audio
                    key={mediaSrc}
                    ref={player as any}
                    src={mediaSrc}
                    controls
                    autoPlay={previewMode !== "original"}
                    onTimeUpdate={(event) =>
                      setCurrent(event.currentTarget.currentTime)
                    }
                  />
                )}
                <div className="time">
                  {fmt(current)} <span>/ {fmt(duration)}</span>
                </div>
              </div>

              {project.words.length > 0 && (
                <div className="review-strip">
                  <span className="review-label">SPOKEN NOW</span>
                  <div>
                    {contextWords.map((word) => (
                      <button
                        key={word.id}
                        onClick={() => seekToWord(word)}
                        className={`review-word ${word.id === active ? "active" : ""} ${
                          word.filler_candidate ? "filler" : ""
                        }`}
                      >
                        {word.text}
                      </button>
                    ))}
                  </div>
                  <span className="review-time">{fmt(sourceCurrent)}</span>
                </div>
              )}

              <div
                className="timeline"
                onClick={(event) => {
                  if (!player.current) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  player.current.currentTime =
                    ((event.clientX - rect.left) / rect.width) * duration;
                }}
              >
                {(showDetected ? project.words : spoken).map((word) => {
                  const start = sourceToPlayback(word.start);
                  const end = sourceToPlayback(word.end);
                  if (start === null || end === null || end <= start)
                    return null;
                  return (
                    <span
                      key={word.id}
                      className={`tick ${word.filler_candidate ? "filler" : ""} ${
                        word.source === "acoustic" ? "acoustic" : ""
                      } ${active === word.id ? "now" : ""} ${
                        selected.includes(word.id) ? "selected" : ""
                      }`}
                      style={{
                        left: `${(start / duration) * 100}%`,
                        width: `${Math.max(0.5, ((end - start) / duration) * 100)}%`,
                      }}
                    />
                  );
                })}
              </div>

              <div className="transcript">
                <div className="transcript-head">
                  <span>TRANSCRIPT</span>
                  <span>
                    {selected.length
                      ? `${selected.length} selected`
                      : "none selected"}
                  </span>
                </div>
                <p>
                  {project.words.length ? (
                    transcriptItems.map(({ marker, word }) =>
                      marker ? (
                        <button
                          key={word.id}
                          onClick={() => toggleWord(word)}
                          title={`Possible filler heard at ${precise(word.start)} — nothing was transcribed here (${Math.round((word.confidence ?? 0) * 100)}% confidence). Click to review.`}
                          className={`filler-marker ${
                            selected.includes(word.id) ? "selected" : ""
                          }`}
                        >
                          ●
                        </button>
                      ) : (
                        <button
                          key={word.id}
                          onClick={() => toggleWord(word)}
                          className={`word ${word.filler_candidate ? "filler" : ""} ${
                            selected.includes(word.id) ? "selected" : ""
                          } ${active === word.id ? "active" : ""}`}
                        >
                          <span>{word.text}</span>
                          <small>
                            {precise(word.start)}-{precise(word.end)}
                          </small>
                        </button>
                      ),
                    )
                  ) : (
                    <span className="empty">
                      Transcript will appear after transcription.
                    </span>
                  )}
                </p>
                {plannedRanges.length > 0 && (
                  <div className="selection-debug">
                    {plannedRanges.map(({ word, start, end }) => (
                      <button
                        key={word.id}
                        className={focusedId === word.id ? "focused" : ""}
                        onClick={() => setFocusedId(word.id)}
                      >
                        <strong>{word.text.trim()}</strong>
                        <span>
                          word {precise(word.start)}-{precise(word.end)}
                        </span>
                        <span>
                          edit {precise(start)}-{precise(end)}
                          {adjusted[word.id] ? " (adjusted)" : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {focusedWord && focusedIndex >= 0 && (
                <BoundaryEditor
                  projectId={project.id}
                  mediaUrl={project.mediaUrl}
                  word={focusedWord}
                  bounds={editBounds(focusedWord)}
                  duration={project.duration}
                  editType={editType}
                  prevWord={focusedNeighbours.previous}
                  nextWord={focusedNeighbours.next}
                  isAdjusted={Boolean(adjusted[focusedWord.id])}
                  onChange={(next) => {
                    invalidatePreview();
                    setAdjusted((existing) => ({
                      ...existing,
                      [focusedWord.id]: next,
                    }));
                  }}
                  onReset={() => {
                    invalidatePreview();
                    setAdjusted(({ [focusedWord.id]: _drop, ...rest }) => rest);
                  }}
                  onPrev={
                    focusedIndex > 0
                      ? () => setFocusedId(selectedWords[focusedIndex - 1].id)
                      : null
                  }
                  onNext={
                    focusedIndex < selectedWords.length - 1
                      ? () => setFocusedId(selectedWords[focusedIndex + 1].id)
                      : null
                  }
                  index={focusedIndex}
                  total={selectedWords.length}
                />
              )}
            </section>
          </section>

          <footer>
            <div>
              {error && <span className="error">{error}</span>}
              {busy && <span className="busy">{busy}</span>}
              {!error && !busy && selectedWords.length > 0 && (
                <span className="selected-ranges">
                  {plannedRanges.map(({ word, start, end }) => (
                    <code key={word.id}>
                      {word.text.trim()} edit {precise(start)}-{precise(end)}
                    </code>
                  ))}
                </span>
              )}
            </div>
            <div className="actions">
              <button
                onClick={selectFillers}
                disabled={
                  !project.words.length || Boolean(busy) || project.finalized
                }
              >
                Select fillers
              </button>
              <button
                onClick={() => {
                  clearPreview();
                  setSelected([]);
                  setFocusedId(null);
                }}
                disabled={
                  !selected.length || Boolean(busy) || project.finalized
                }
              >
                Clear selection
              </button>
              <div className="segmented">
                {/* Silencing a word in an audio-only project just leaves a dead
                    gap where it was, so only video offers the choice. */}
                {project.kind === "video" && (
                  <button
                    className={editType === "mute" ? "active" : ""}
                    onClick={() => {
                      clearPreview();
                      setEditType("mute");
                    }}
                    disabled={Boolean(busy) || project.finalized}
                  >
                    Silence
                  </button>
                )}
                <button
                  className={editType === "ripple_delete" ? "active" : ""}
                  onClick={() => {
                    clearPreview();
                    setEditType("ripple_delete");
                  }}
                  disabled={Boolean(busy) || project.finalized}
                >
                  Remove
                </button>
              </div>
              <button
                className="primary"
                onClick={previewSelection}
                disabled={
                  !selected.length || Boolean(busy) || project.finalized
                }
              >
                Preview selected edit
              </button>
              <button
                className="finalize"
                onClick={prepareDownload}
                disabled={
                  !selected.length || Boolean(busy) || project.finalized
                }
              >
                Prepare download
              </button>
            </div>
          </footer>

          {downloadUrl && (
            <a className="download" href={downloadUrl}>
              Download final file
            </a>
          )}
        </>
      )}
    </main>
  );
}
