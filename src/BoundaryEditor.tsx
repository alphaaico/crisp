import { useEffect, useRef, useState } from "react";

export type Word = {
  id: string;
  text: string;
  start: number;
  end: number;
  filler_candidate: boolean;
  edit_state: string;
  source?: "asr" | "acoustic";
  confidence?: number;
};

export type Bounds = { start: number; end: number };

// The waveform view is padded around the *word*, not around the current
// handle positions, so the picture stays still while you drag.
const VIEW_PAD = 1;
const MIN_LENGTH = 0.02;
const NUDGE = 0.01;
const NUDGE_COARSE = 0.05;
const VIEW_W = 1000;
const VIEW_H = 120;

const precise = (t: number) => `${t.toFixed(3)}s`;
const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

export default function BoundaryEditor({
  projectId,
  mediaUrl,
  word,
  bounds,
  duration,
  editType,
  prevWord,
  nextWord,
  isAdjusted,
  onChange,
  onReset,
  onPrev,
  onNext,
  index,
  total,
}: {
  projectId: string;
  mediaUrl: string;
  word: Word;
  bounds: Bounds;
  duration: number;
  editType: "ripple_delete" | "mute";
  prevWord: Word | null;
  nextWord: Word | null;
  isAdjusted: boolean;
  onChange: (bounds: Bounds) => void;
  onReset: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  index: number;
  total: number;
}) {
  const [peaks, setPeaks] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [activeHandle, setActiveHandle] = useState<"start" | "end">("start");
  const svgRef = useRef<SVGSVGElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const dragRef = useRef<"start" | "end" | null>(null);
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  // Nudges and drag moves can fire several times within a single frame (key
  // repeat, high-rate pointer events). Reading `bounds` straight from props
  // would hand each of them the same pre-render value and lose all but the
  // last, so every change updates the ref immediately and later changes
  // compound off that instead.
  const commit = (next: Bounds) => {
    boundsRef.current = next;
    onChange(next);
  };

  const viewStart = Math.max(0, word.start - VIEW_PAD);
  const viewEnd = Math.min(duration, word.end + VIEW_PAD);
  const span = Math.max(0.001, viewEnd - viewStart);
  const xFor = (time: number) => ((time - viewStart) / span) * VIEW_W;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setPeaks([]);
    fetch(
      `/api/projects/${projectId}/waveform?start=${viewStart}&end=${viewEnd}&bins=700`,
    )
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        else setPeaks(data.peaks || []);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, word.id, viewStart, viewEnd]);

  // Stepping to another word (or closing the panel) must not leave audio
  // playing on from the previous one.
  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
      frameRef.current = null;
      timerRef.current = null;
      audioRef.current?.pause();
      setPlaying(false);
      setPlayhead(null);
    },
    [word.id],
  );

  useEffect(() => {
    const timeAt = (clientX: number) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
      return viewStart + fraction * span;
    };
    const move = (event: PointerEvent) => {
      if (!dragRef.current) return;
      const time = timeAt(event.clientX);
      if (time === null) return;
      const current = boundsRef.current;
      if (dragRef.current === "start")
        commit({
          start: clamp(time, viewStart, current.end - MIN_LENGTH),
          end: current.end,
        });
      else
        commit({
          start: current.start,
          end: clamp(time, current.start + MIN_LENGTH, viewEnd),
        });
    };
    const stop = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [onChange, viewStart, viewEnd, span]);

  const nudge = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step =
      (event.shiftKey ? NUDGE_COARSE : NUDGE) *
      (event.key === "ArrowLeft" ? -1 : 1);
    const current = boundsRef.current;
    if (activeHandle === "start")
      commit({
        start: clamp(current.start + step, viewStart, current.end - MIN_LENGTH),
        end: current.end,
      });
    else
      commit({
        start: current.start,
        end: clamp(current.end + step, current.start + MIN_LENGTH, viewEnd),
      });
  };

  // Plays exactly what sits between the handles, straight from the original
  // media. The question this answers is "am I about to delete the right
  // sound?", so it plays the selection itself rather than the result — and
  // playing locally means no render round-trip between adjustments.
  //
  // Stopping on time takes two mechanisms. `timeupdate` fires only a few
  // times a second, far too coarse to land inside a ~90ms selection, and
  // rAF is throttled to a standstill whenever the tab is not visible — on
  // its own it let playback run seconds past the end. So a timer owns the
  // actual stop (it keeps running in the background) and rAF only drives
  // the playhead, cutting things short if it happens to notice first.
  const stop = () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    if (timerRef.current) clearTimeout(timerRef.current);
    frameRef.current = null;
    timerRef.current = null;
    audioRef.current?.pause();
    setPlaying(false);
    setPlayhead(null);
  };

  const playSelection = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    setError("");
    try {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
      // Seeking before the media has metadata is silently ignored, which
      // starts playback from zero instead of from the selection.
      if (audio.readyState < 1) {
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            audio.removeEventListener("loadedmetadata", done);
            audio.removeEventListener("error", failed);
            resolve();
          };
          const failed = () => {
            audio.removeEventListener("loadedmetadata", done);
            audio.removeEventListener("error", failed);
            reject(new Error("Could not load the audio for playback."));
          };
          audio.addEventListener("loadedmetadata", done);
          audio.addEventListener("error", failed);
          audio.load();
        });
      }
      const { start, end } = boundsRef.current;
      audio.currentTime = start;
      await audio.play();
      setPlaying(true);
      timerRef.current = window.setTimeout(stop, (end - start) * 1000 + 40);
      const tick = () => {
        const element = audioRef.current;
        if (!element) return;
        if (element.currentTime >= boundsRef.current.end) return stop();
        setPlayhead(element.currentTime);
        frameRef.current = requestAnimationFrame(tick);
      };
      frameRef.current = requestAnimationFrame(tick);
    } catch (e: any) {
      setError(e.message);
      stop();
    }
  };

  const barWidth = peaks.length ? VIEW_W / peaks.length : 0;
  const markers = [
    prevWord && {
      time: prevWord.end,
      label: `end of "${prevWord.text.trim()}"`,
      atEnd: true,
    },
    nextWord && {
      time: nextWord.start,
      label: `start of "${nextWord.text.trim()}"`,
      atEnd: false,
    },
  ].filter(Boolean) as { time: number; label: string; atEnd: boolean }[];

  return (
    <div className="boundary-editor" tabIndex={0} onKeyDown={nudge}>
      <div className="boundary-head">
        <div>
          <span className="eyebrow">ADJUST CUT</span>
          <strong>{word.text.trim()}</strong>
          <span className="boundary-count">
            {index + 1} of {total}
          </span>
          {isAdjusted && <span className="boundary-tag">adjusted</span>}
        </div>
        <div className="boundary-nav">
          <button onClick={() => onPrev?.()} disabled={!onPrev}>
            ‹ Prev
          </button>
          <button onClick={() => onNext?.()} disabled={!onNext}>
            Next ›
          </button>
        </div>
      </div>

      <svg
        ref={svgRef}
        className="boundary-wave"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
      >
        <rect
          x={xFor(bounds.start)}
          width={Math.max(1, xFor(bounds.end) - xFor(bounds.start))}
          y={0}
          height={VIEW_H}
          className={`boundary-region ${editType === "mute" ? "mute" : "cut"}`}
        />
        {peaks.map((peak, i) => {
          const time = viewStart + ((i + 0.5) / peaks.length) * span;
          const height = Math.max(1, peak * (VIEW_H - 8));
          const inside = time >= bounds.start && time <= bounds.end;
          return (
            <rect
              key={i}
              x={i * barWidth}
              width={Math.max(0.6, barWidth * 0.85)}
              y={(VIEW_H - height) / 2}
              height={height}
              className={`boundary-bar ${inside ? "inside" : ""}`}
            />
          );
        })}
        {markers.map((marker) => (
          <g key={marker.label}>
            <line
              x1={xFor(marker.time)}
              x2={xFor(marker.time)}
              y1={0}
              y2={VIEW_H}
              className="boundary-marker"
            />
            {/* Labelled at the line itself — a detached legend underneath made
                it impossible to tell which guide was which. */}
            <text
              x={xFor(marker.time) + (marker.atEnd ? -4 : 4)}
              y={12}
              textAnchor={marker.atEnd ? "end" : "start"}
              className="boundary-marker-label"
            >
              {marker.label}
            </text>
          </g>
        ))}
        {playhead !== null && (
          <line
            x1={xFor(playhead)}
            x2={xFor(playhead)}
            y1={0}
            y2={VIEW_H}
            className="boundary-playhead"
          />
        )}
        {(["start", "end"] as const).map((side) => (
          <g key={side}>
            <line
              x1={xFor(bounds[side])}
              x2={xFor(bounds[side])}
              y1={0}
              y2={VIEW_H}
              className={`boundary-handle-line ${activeHandle === side ? "active" : ""}`}
            />
            <rect
              x={xFor(bounds[side]) - 9}
              width={18}
              y={0}
              height={VIEW_H}
              className="boundary-handle-hit"
              onPointerDown={(event) => {
                event.preventDefault();
                dragRef.current = side;
                setActiveHandle(side);
              }}
            />
          </g>
        ))}
      </svg>

      {loading && <div className="boundary-legend">loading waveform…</div>}

      <div className="boundary-foot">
        <code>
          {editType === "mute" ? "silencing" : "removing"}{" "}
          <b>{Math.round((bounds.end - bounds.start) * 1000)}ms</b>{" "}
          {precise(bounds.start)} → {precise(bounds.end)}
        </code>
        <div className="boundary-actions">
          <button
            className="primary"
            onClick={playing ? stop : playSelection}
            disabled={bounds.end - bounds.start < MIN_LENGTH}
          >
            {playing ? "■ Stop" : "▶ Play selection"}
          </button>
          <button onClick={onReset} disabled={!isAdjusted}>
            Reset
          </button>
        </div>
      </div>
      <p className="boundary-hint">
        Play the selection to hear exactly what gets{" "}
        {editType === "mute" ? "silenced" : "removed"} — if you hear part of a
        real word, drag that edge inward. Drag either edge, or click one and
        use ← → to nudge 10ms (hold Shift for 50ms).
      </p>
      {error && <span className="error">{error}</span>}
      <audio ref={audioRef} src={mediaUrl} preload="auto" hidden />
    </div>
  );
}
