import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  createGrandPianoVoice,
  grandPianoVelocity,
  warmGrandPiano,
} from "../features/piano/grandPiano";
import "./PianoWindow.css";

type PlayMode = "free" | "chord" | "ear";
type EarFeedback = "idle" | "listening" | "correct" | "wrong";

type OscillatorKind = OscillatorType;

interface TimbrePreset {
  id: number;
  name: string;
  attack: number;
  release: number;
  partials: { waveform: OscillatorKind; ratio: number; gain: number; detune?: number }[];
}

interface KeyboardNote {
  key: string;
  note: string;
  midi: number;
}

interface ActiveSound {
  visualKey: string | null;
  pendingRelease: boolean;
  release: () => void;
}

const KEY_ROWS = [
  { keys: ["z", "x", "c", "v", "b", "n", "m"], octave: 3 },
  { keys: ["a", "s", "d", "f", "g", "h", "j"], octave: 4 },
  { keys: ["q", "w", "e", "r", "t", "y", "u"], octave: 5 },
] as const;

const NATURAL_NOTES = [
  { name: "C", semitone: 0 },
  { name: "D", semitone: 2 },
  { name: "E", semitone: 4 },
  { name: "F", semitone: 5 },
  { name: "G", semitone: 7 },
  { name: "A", semitone: 9 },
  { name: "B", semitone: 11 },
] as const;

const FREE_ROWS: KeyboardNote[][] = KEY_ROWS.map(({ keys, octave }) =>
  keys.map((key, index) => {
    const natural = NATURAL_NOTES[index];
    return {
      key,
      note: `${natural.name}${octave}`,
      midi: 12 * (octave + 1) + natural.semitone,
    };
  }),
);

const FREE_BY_KEY = new Map(FREE_ROWS.flat().map((item) => [item.key, item]));
const EAR_TRAINING_NOTES = FREE_ROWS.flat();

const TIMBRES: TimbrePreset[] = [
  {
    id: 0,
    name: "钟琴",
    attack: 0.008,
    release: 1.2,
    partials: [
      { waveform: "sine", ratio: 1, gain: 0.62 },
      { waveform: "sine", ratio: 2.76, gain: 0.28 },
      { waveform: "sine", ratio: 4.1, gain: 0.1 },
    ],
  },
  {
    id: 1,
    name: "三角钢琴",
    attack: 0.008,
    release: 0.72,
    partials: [
      { waveform: "sine", ratio: 1, gain: 0.54 },
      { waveform: "triangle", ratio: 2, gain: 0.26, detune: -4 },
      { waveform: "sine", ratio: 3, gain: 0.13, detune: 3 },
      { waveform: "sine", ratio: 4.02, gain: 0.07 },
    ],
  },
  {
    id: 2,
    name: "电钢",
    attack: 0.018,
    release: 0.95,
    partials: [
      { waveform: "sine", ratio: 1, gain: 0.56 },
      { waveform: "sine", ratio: 2, gain: 0.22 },
      { waveform: "triangle", ratio: 1.5, gain: 0.18, detune: 6 },
      { waveform: "sine", ratio: 4, gain: 0.04 },
    ],
  },
  {
    id: 3,
    name: "风琴",
    attack: 0.03,
    release: 0.42,
    partials: [
      { waveform: "sine", ratio: 1, gain: 0.45 },
      { waveform: "sine", ratio: 2, gain: 0.25 },
      { waveform: "sine", ratio: 3, gain: 0.17 },
      { waveform: "sine", ratio: 4, gain: 0.13 },
    ],
  },
  {
    id: 4,
    name: "弦乐",
    attack: 0.16,
    release: 1.1,
    partials: [
      { waveform: "sawtooth", ratio: 1, gain: 0.38, detune: -7 },
      { waveform: "sawtooth", ratio: 1, gain: 0.32, detune: 7 },
      { waveform: "triangle", ratio: 2, gain: 0.16 },
      { waveform: "sine", ratio: 0.5, gain: 0.14 },
    ],
  },
  {
    id: 5,
    name: "拇指琴",
    attack: 0.006,
    release: 1.05,
    partials: [
      { waveform: "sine", ratio: 1, gain: 0.66 },
      { waveform: "sine", ratio: 2.12, gain: 0.22 },
      { waveform: "sine", ratio: 3.35, gain: 0.12 },
    ],
  },
  {
    id: 6,
    name: "柔垫",
    attack: 0.22,
    release: 1.35,
    partials: [
      { waveform: "triangle", ratio: 0.5, gain: 0.2 },
      { waveform: "sine", ratio: 1, gain: 0.5, detune: -5 },
      { waveform: "sine", ratio: 1, gain: 0.3, detune: 5 },
    ],
  },
  {
    id: 7,
    name: "拨弦",
    attack: 0.004,
    release: 0.55,
    partials: [
      { waveform: "triangle", ratio: 1, gain: 0.58 },
      { waveform: "sine", ratio: 2.02, gain: 0.24 },
      { waveform: "sine", ratio: 3.01, gain: 0.18 },
    ],
  },
  {
    id: 8,
    name: "合成主音",
    attack: 0.018,
    release: 0.48,
    partials: [
      { waveform: "sawtooth", ratio: 1, gain: 0.55 },
      { waveform: "square", ratio: 1, gain: 0.22, detune: 8 },
      { waveform: "triangle", ratio: 2, gain: 0.23 },
    ],
  },
  {
    id: 9,
    name: "低音",
    attack: 0.012,
    release: 0.65,
    partials: [
      { waveform: "sine", ratio: 0.5, gain: 0.42 },
      { waveform: "triangle", ratio: 1, gain: 0.48 },
      { waveform: "sine", ratio: 2, gain: 0.1 },
    ],
  },
];

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function createVoice(
  context: AudioContext,
  destination: AudioNode,
  frequency: number,
  preset: TimbrePreset,
  amplitude: number,
): () => void {
  const now = context.currentTime;
  const output = context.createGain();
  const gain = output.gain;
  const target = amplitude;
  let released = false;

  gain.setValueAtTime(0.0001, now);
  gain.exponentialRampToValueAtTime(target, now + preset.attack);
  gain.exponentialRampToValueAtTime(Math.max(0.0001, target * 0.56), now + preset.attack + 0.32);
  output.connect(destination);

  const oscillators = preset.partials.map((partial) => {
    const oscillator = context.createOscillator();
    const partialGain = context.createGain();
    oscillator.type = partial.waveform;
    oscillator.frequency.setValueAtTime(frequency * partial.ratio, now);
    oscillator.detune.setValueAtTime(partial.detune ?? 0, now);
    partialGain.gain.setValueAtTime(partial.gain, now);
    oscillator.connect(partialGain);
    partialGain.connect(output);
    oscillator.start(now);
    return oscillator;
  });

  return () => {
    if (released) return;
    released = true;
    const releaseAt = context.currentTime;
    gain.cancelScheduledValues(releaseAt);
    gain.setValueAtTime(Math.max(0.0001, gain.value), releaseAt);
    gain.exponentialRampToValueAtTime(0.0001, releaseAt + preset.release);
    for (const oscillator of oscillators) {
      oscillator.stop(releaseAt + preset.release + 0.08);
    }
  };
}

function resolveTones(key: string, mode: PlayMode): { midi: number; label: string }[] | null {
  const note = FREE_BY_KEY.get(key);
  if (!note) return null;
  if (mode !== "chord") return [{ midi: note.midi, label: note.note }];
  const chordRoot = note.midi;
  return [
    { midi: chordRoot, label: note.note },
    { midi: chordRoot + 4, label: "" },
    { midi: chordRoot + 7, label: "" },
  ];
}

function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

export default function PianoWindow() {
  const [mode, setMode] = useState<PlayMode>("free");
  const [timbre, setTimbre] = useState(1);
  const [sustain, setSustain] = useState(false);
  const [volume, setVolume] = useState(70);
  const [activeKeys, setActiveKeys] = useState<Set<string>>(() => new Set());
  const [grandPianoState, setGrandPianoState] = useState<"loading" | "ready" | "error">("loading");
  const [earQuestion, setEarQuestion] = useState<KeyboardNote | null>(null);
  const [earFeedback, setEarFeedback] = useState<EarFeedback>("idle");
  const [earGuessKey, setEarGuessKey] = useState<string | null>(null);
  const [earStats, setEarStats] = useState({ correct: 0, total: 0 });
  const contextRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const activeSoundsRef = useRef(new Map<string, ActiveSound>());
  const modeRef = useRef(mode);
  const timbreRef = useRef(timbre);
  const sustainRef = useRef(false);
  const volumeRef = useRef(volume);
  const earQuestionRef = useRef<KeyboardNote | null>(null);
  const earFeedbackRef = useRef<EarFeedback>("idle");
  const earNextTimerRef = useRef<number | null>(null);
  const earPromptTimerRef = useRef<number | null>(null);

  const selectedPreset = TIMBRES[timbre];
  const legend = mode === "free"
    ? "自然音自由演奏"
    : mode === "chord"
      ? "大三和弦伴奏"
      : "听音辨音训练";

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    timbreRef.current = timbre;
  }, [timbre]);

  const refreshActiveKeys = useCallback(() => {
    setActiveKeys(
      new Set(
        [...activeSoundsRef.current.values()]
          .map((sound) => sound.visualKey)
          .filter((key): key is string => Boolean(key)),
      ),
    );
  }, []);

  const getContext = useCallback(() => {
    if (!contextRef.current) {
      const context = new AudioContext();
      const masterGain = context.createGain();
      masterGain.gain.setValueAtTime(volumeRef.current / 100, context.currentTime);
      masterGain.connect(context.destination);
      contextRef.current = context;
      masterGainRef.current = masterGain;
    }
    if (contextRef.current.state === "suspended") {
      void contextRef.current.resume();
    }
    return contextRef.current;
  }, []);

  const changeVolume = useCallback((nextVolume: number) => {
    const next = Math.max(0, Math.min(100, Math.round(nextVolume)));
    volumeRef.current = next;
    setVolume(next);

    const context = contextRef.current;
    const masterGain = masterGainRef.current;
    if (!context || !masterGain) return;
    masterGain.gain.cancelScheduledValues(context.currentTime);
    masterGain.gain.setTargetAtTime(next / 100, context.currentTime, 0.02);
  }, []);

  useEffect(() => {
    let alive = true;
    const context = getContext();
    void warmGrandPiano(context)
      .then(() => {
        if (alive) setGrandPianoState("ready");
      })
      .catch((error) => {
        console.error("[bugzia] warm grand piano", error);
        if (alive) setGrandPianoState("error");
      });
    return () => {
      alive = false;
    };
  }, [getContext]);

  const releaseSound = useCallback(
    (id: string, force = false) => {
      const sound = activeSoundsRef.current.get(id);
      if (!sound) return;
      if (sustainRef.current && !force) {
        sound.pendingRelease = true;
        return;
      }
      sound.release();
      activeSoundsRef.current.delete(id);
      refreshActiveKeys();
    },
    [refreshActiveKeys],
  );

  const releaseAll = useCallback(() => {
    for (const sound of activeSoundsRef.current.values()) {
      sound.release();
    }
    activeSoundsRef.current.clear();
    refreshActiveKeys();
  }, [refreshActiveKeys]);

  const releaseSustainedSounds = useCallback(() => {
    sustainRef.current = false;
    setSustain(false);
    for (const [id, sound] of activeSoundsRef.current) {
      if (sound.pendingRelease) releaseSound(id, true);
    }
  }, [releaseSound]);

  const clearEarTimers = useCallback(() => {
    if (earNextTimerRef.current !== null) {
      window.clearTimeout(earNextTimerRef.current);
      earNextTimerRef.current = null;
    }
    if (earPromptTimerRef.current !== null) {
      window.clearTimeout(earPromptTimerRef.current);
      earPromptTimerRef.current = null;
    }
  }, []);

  const startSound = useCallback(
    (
      id: string,
      visualKey: string | null,
      tones: { midi: number; label: string }[],
      pressure?: number,
    ) => {
      if (activeSoundsRef.current.has(id)) return;
      const context = getContext();
      const destination = masterGainRef.current;
      if (!destination) return;
      const preset = TIMBRES[timbreRef.current];
      const amplitude = tones.length === 1 ? 0.16 : 0.075;
      let released = false;
      let releaseVoices: (() => void)[] = [];
      const sound: ActiveSound = {
        visualKey,
        pendingRelease: false,
        release: () => {
          released = true;
          releaseVoices.forEach((release) => release());
        },
      };
      activeSoundsRef.current.set(id, sound);
      refreshActiveKeys();

      if (timbreRef.current === 1) {
        const velocity = grandPianoVelocity(tones.length, pressure);
        void Promise.all(
          tones.map((tone) =>
            createGrandPianoVoice(context, destination, tone.midi, velocity, amplitude),
          ),
        )
          .then((voices) => {
            releaseVoices = voices;
            if (released) releaseVoices.forEach((release) => release());
          })
          .catch((error) => {
            console.error("[bugzia] play grand piano", error);
            setGrandPianoState("error");
            if (activeSoundsRef.current.get(id) === sound) {
              activeSoundsRef.current.delete(id);
              refreshActiveKeys();
            }
          });
        return;
      }

      releaseVoices = tones.map((tone) =>
        createVoice(context, destination, midiToFrequency(tone.midi), preset, amplitude),
      );
    },
    [getContext, refreshActiveKeys],
  );

  const playEarQuestion = useCallback(
    (question: KeyboardNote) => {
      if (earPromptTimerRef.current !== null) {
        window.clearTimeout(earPromptTimerRef.current);
        earPromptTimerRef.current = null;
      }
      releaseSound("ear:prompt", true);
      startSound("ear:prompt", null, [{ midi: question.midi, label: question.note }]);
      earPromptTimerRef.current = window.setTimeout(() => {
        releaseSound("ear:prompt", true);
        earPromptTimerRef.current = null;
      }, 850);
    },
    [releaseSound, startSound],
  );

  const startEarQuestion = useCallback(
    (previousKey?: string | null) => {
      clearEarTimers();
      const excludedKey = previousKey ?? earQuestionRef.current?.key ?? null;
      const candidates = EAR_TRAINING_NOTES.filter((note) => note.key !== excludedKey);
      const nextQuestion = candidates[Math.floor(Math.random() * candidates.length)]
        ?? EAR_TRAINING_NOTES[0];
      earQuestionRef.current = nextQuestion;
      earFeedbackRef.current = "listening";
      setEarQuestion(nextQuestion);
      setEarGuessKey(null);
      setEarFeedback("listening");
      playEarQuestion(nextQuestion);
    },
    [clearEarTimers, playEarQuestion],
  );

  const replayEarQuestion = useCallback(() => {
    const question = earQuestionRef.current;
    if (!question) {
      startEarQuestion(null);
      return;
    }
    playEarQuestion(question);
  }, [playEarQuestion, startEarQuestion]);

  const submitEarAnswer = useCallback(
    (key: string) => {
      const question = earQuestionRef.current;
      if (!question || earFeedbackRef.current !== "listening") return;
      clearEarTimers();
      releaseSound("ear:prompt", true);

      const isCorrect = key === question.key;
      earFeedbackRef.current = isCorrect ? "correct" : "wrong";
      setEarGuessKey(key);
      setEarFeedback(isCorrect ? "correct" : "wrong");
      setEarStats((current) => ({
        correct: current.correct + (isCorrect ? 1 : 0),
        total: current.total + 1,
      }));

      earNextTimerRef.current = window.setTimeout(() => {
        earNextTimerRef.current = null;
        if (modeRef.current === "ear") startEarQuestion(question.key);
      }, 1000);
    },
    [clearEarTimers, releaseSound, startEarQuestion],
  );

  const changeMode = useCallback(
    (next: PlayMode) => {
      if (next === modeRef.current) return;
      releaseAll();
      setMode(next);
    },
    [releaseAll],
  );

  useEffect(() => {
    if (mode === "ear") {
      startEarQuestion(earQuestionRef.current?.key ?? null);
      return;
    }

    clearEarTimers();
    releaseSound("ear:prompt", true);
    earQuestionRef.current = null;
    earFeedbackRef.current = "idle";
    setEarQuestion(null);
    setEarGuessKey(null);
    setEarFeedback("idle");
  }, [clearEarTimers, mode, releaseSound, startEarQuestion]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextInput(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        releaseAll();
        void getCurrentWindow().close();
        return;
      }
      if (event.key === "Shift") {
        event.preventDefault();
        sustainRef.current = true;
        setSustain(true);
        return;
      }
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        setTimbre(Number(event.key));
        return;
      }
      const key = event.key.toLowerCase();
      if (modeRef.current === "ear") {
        if (!FREE_BY_KEY.has(key) || event.repeat) return;
        event.preventDefault();
        submitEarAnswer(key);
        return;
      }
      const tones = resolveTones(key, modeRef.current);
      if (!tones || event.repeat) return;
      event.preventDefault();
      startSound(`keyboard:${key}`, key, tones);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        event.preventDefault();
        releaseSustainedSounds();
        return;
      }
      const key = event.key.toLowerCase();
      if (!FREE_BY_KEY.has(key)) return;
      if (modeRef.current === "ear") {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      releaseSound(`keyboard:${key}`);
    };

    const onPointerUp = (event: PointerEvent) => {
      releaseSound(`pointer:${event.pointerId}`);
    };

    const onBlur = () => {
      sustainRef.current = false;
      setSustain(false);
      releaseAll();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onBlur);
      clearEarTimers();
      releaseAll();
      masterGainRef.current?.disconnect();
      masterGainRef.current = null;
      void contextRef.current?.close();
      contextRef.current = null;
    };
  }, [clearEarTimers, releaseAll, releaseSound, releaseSustainedSounds, startSound, submitEarAnswer]);

  const keyRows = useMemo(
    () =>
      [...FREE_ROWS].reverse().map((row) =>
        row.map((item) => {
          const tones = resolveTones(item.key, mode);
          return { ...item, tones: tones ?? [] };
        }),
      ),
    [mode],
  );

  const guessedNote = earGuessKey ? FREE_BY_KEY.get(earGuessKey) : null;
  const noteSummary = mode === "free"
    ? "C3–B5，自然音"
    : mode === "chord"
      ? "C3–B5，每键一个大三和弦"
      : "C3–B5，听音辨音";
  const earResultText = !earQuestion
    ? "准备出题"
    : earFeedback === "correct"
      ? `正确：${earQuestion.note}`
      : earFeedback === "wrong"
        ? `还差一点：你选了 ${guessedNote?.note ?? "未知"}，答案是 ${earQuestion.note}`
        : "听完后按下对应音名的琴键";

  return (
    <main className="piano-window">
      <header className="piano-titlebar" data-tauri-drag-region>
        <div className="piano-title">
          <span>Bugzia Piano</span>
          <small>{legend}</small>
        </div>
        <button
          className="piano-close"
          type="button"
          title="关闭钢琴"
          aria-label="关闭钢琴"
          onClick={() => {
            releaseAll();
            void getCurrentWindow().close();
          }}
        >
          ×
        </button>
      </header>

      <section className="piano-controls" aria-label="演奏控制">
        <div className="piano-mode-switch" role="group" aria-label="演奏模式">
          <button
            className={mode === "free" ? "selected" : ""}
            type="button"
            onClick={() => changeMode("free")}
          >
            自由演奏
          </button>
          <button
            className={mode === "chord" ? "selected" : ""}
            type="button"
            onClick={() => changeMode("chord")}
          >
            和弦伴奏
          </button>
          <button
            className={mode === "ear" ? "selected" : ""}
            type="button"
            onClick={() => changeMode("ear")}
          >
            听音训练
          </button>
        </div>
        <span className={"sustain-indicator" + (sustain ? " active" : "")}>
          Shift 延音
        </span>
        <label className="piano-volume">
          <span>音量</span>
          <input
            type="range"
            min="0"
            max="100"
            value={volume}
            aria-label="钢琴音量"
            onChange={(event) => changeVolume(Number(event.currentTarget.value))}
          />
          <output>{volume}%</output>
        </label>
        <span className="piano-exit">Esc 返回</span>
      </section>

      <section className="piano-stage">
        <div className="piano-stage-top">
          <div className="piano-note-summary">
            <span>{noteSummary}</span>
            <strong>
              {timbre === 1 && grandPianoState === "loading" ? "三角钢琴加载中" : selectedPreset.name}
            </strong>
          </div>

          {mode === "ear" ? (
            <div className="ear-training-panel">
              <button
                className="ear-replay"
                type="button"
                onClick={replayEarQuestion}
                disabled={!earQuestion || earFeedback !== "listening"}
              >
                重放本题
              </button>
              <span className={"ear-result " + earFeedback} aria-live="polite">
                {earResultText}
              </span>
              <output className="ear-score" aria-label="听音训练得分">
                {earStats.correct}/{earStats.total}
              </output>
            </div>
          ) : null}
        </div>

        <div className="piano-keyboard" aria-label={legend}>
          {keyRows.map((row) => (
            <div className="piano-key-row" key={row[0]?.note}>
              {row.map((item) => {
                const isActive = activeKeys.has(item.key);
                const isEarCorrect = mode === "ear"
                  && (earFeedback === "correct" || earFeedback === "wrong")
                  && earQuestion?.key === item.key;
                const isEarWrong = mode === "ear"
                  && earFeedback === "wrong"
                  && earGuessKey === item.key
                  && earGuessKey !== earQuestion?.key;
                const chordName = item.note.slice(0, 1);
                const title = mode === "chord"
                  ? `${item.key.toUpperCase()}：${chordName} 大三和弦`
                  : mode === "ear"
                    ? `${item.key.toUpperCase()}：${item.note}，听音作答`
                    : `${item.key.toUpperCase()}：${item.note}`;
                const keyClassName = [
                  "piano-key",
                  isActive ? "active" : "",
                  isEarCorrect ? "ear-correct" : "",
                  isEarWrong ? "ear-wrong" : "",
                ].filter(Boolean).join(" ");
                return (
                  <button
                    className={keyClassName}
                    type="button"
                    key={item.key}
                    title={title}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      if (mode === "ear") {
                        submitEarAnswer(item.key);
                        return;
                      }
                      event.currentTarget.setPointerCapture(event.pointerId);
                      startSound(`pointer:${event.pointerId}`, item.key, item.tones, event.pressure);
                    }}
                    onPointerUp={(event) => {
                      if (mode === "ear") return;
                      releaseSound(`pointer:${event.pointerId}`);
                    }}
                    onPointerCancel={(event) => {
                      if (mode === "ear") return;
                      releaseSound(`pointer:${event.pointerId}`);
                    }}
                  >
                    <span className="piano-key-note">
                      {mode === "chord" ? `${chordName} 大` : item.note}
                    </span>
                    <kbd>{item.key.toUpperCase()}</kbd>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      <section className="timbre-strip" aria-label="音色选择">
        {TIMBRES.map((preset) => (
          <button
            className={"timbre-key" + (preset.id === timbre ? " selected" : "")}
            type="button"
            key={preset.id}
            onClick={() => setTimbre(preset.id)}
            aria-pressed={preset.id === timbre}
          >
            <kbd>{preset.id}</kbd>
            <span>{preset.name}</span>
          </button>
        ))}
      </section>
    </main>
  );
}
