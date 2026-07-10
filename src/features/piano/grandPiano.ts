interface GrandPianoSample {
  url: string;
  midi: number;
  velocity: number;
}

interface CachedBuffer {
  lastUsed: number;
  value: Promise<AudioBuffer>;
}

const NOTE_SEMITONES: Record<string, number> = {
  A: 9,
  C: 0,
  Dsharp: 3,
  Fsharp: 6,
};
const MAX_DECODED_BUFFERS = 32;

const sampleUrls = import.meta.glob("../../assets/piano/salamander/*.ogg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const SAMPLES: GrandPianoSample[] = Object.entries(sampleUrls)
  .flatMap(([path, url]) => {
    const match = /\/(A|C|Dsharp|Fsharp)(\d+)v(\d+)\.ogg$/.exec(path);
    if (!match) return [];
    const [, note, octaveText, velocityText] = match;
    const semitone = NOTE_SEMITONES[note];
    if (semitone === undefined) return [];
    const octave = Number(octaveText);
    const velocity = Number(velocityText);
    return [{
      url,
      midi: 12 * (octave + 1) + semitone,
      velocity,
    }];
  })
  .sort((a, b) => a.midi - b.midi || a.velocity - b.velocity);

const buffersByContext = new WeakMap<AudioContext, Map<string, CachedBuffer>>();

function bufferCache(context: AudioContext): Map<string, CachedBuffer> {
  let cache = buffersByContext.get(context);
  if (!cache) {
    cache = new Map();
    buffersByContext.set(context, cache);
  }
  return cache;
}

function trimBufferCache(cache: Map<string, CachedBuffer>): void {
  if (cache.size <= MAX_DECODED_BUFFERS) return;
  const stale = [...cache.entries()]
    .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)
    .slice(0, cache.size - MAX_DECODED_BUFFERS);
  for (const [url] of stale) cache.delete(url);
}

async function loadSampleBuffer(
  context: AudioContext,
  sample: GrandPianoSample,
): Promise<AudioBuffer> {
  const cache = bufferCache(context);
  const cached = cache.get(sample.url);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.value;
  }

  const value = fetch(sample.url)
    .then(async (response) => {
      if (!response.ok) throw new Error(`load piano sample failed: ${response.status}`);
      return context.decodeAudioData(await response.arrayBuffer());
    })
    .catch((error) => {
      cache.delete(sample.url);
      throw error;
    });
  cache.set(sample.url, { lastUsed: Date.now(), value });
  trimBufferCache(cache);
  return value;
}

function closestSample(midi: number, velocity: number): GrandPianoSample {
  const selectedVelocity = Math.max(1, Math.min(16, Math.round(velocity)));
  let closest = SAMPLES[0];
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const sample of SAMPLES) {
    if (sample.velocity !== selectedVelocity) continue;
    const distance = Math.abs(sample.midi - midi);
    if (distance < closestDistance) {
      closest = sample;
      closestDistance = distance;
    }
  }

  if (!closest) throw new Error("No grand piano samples are available.");
  return closest;
}

export function grandPianoVelocity(noteCount: number, pressure?: number): number {
  if (pressure && pressure > 0) return Math.max(1, Math.min(16, Math.round(pressure * 16)));
  return noteCount > 1 ? 12 : 9;
}

/** Decode the normal-strike layer ahead of the first key press. */
export async function warmGrandPiano(context: AudioContext): Promise<void> {
  await Promise.all(
    SAMPLES
      .filter((sample) => sample.velocity === 9)
      .map((sample) => loadSampleBuffer(context, sample)),
  );
}

export async function createGrandPianoVoice(
  context: AudioContext,
  midi: number,
  velocity: number,
  amplitude: number,
): Promise<() => void> {
  const sample = closestSample(midi, velocity);
  const buffer = await loadSampleBuffer(context, sample);
  const source = context.createBufferSource();
  const gainNode = context.createGain();
  const now = context.currentTime;
  let released = false;

  source.buffer = buffer;
  source.playbackRate.setValueAtTime(2 ** ((midi - sample.midi) / 12), now);
  gainNode.gain.setValueAtTime(0.0001, now);
  gainNode.gain.exponentialRampToValueAtTime(amplitude, now + 0.008);
  source.connect(gainNode);
  gainNode.connect(context.destination);
  source.start(now);

  return () => {
    if (released) return;
    released = true;
    const releaseAt = context.currentTime;
    gainNode.gain.cancelScheduledValues(releaseAt);
    gainNode.gain.setValueAtTime(Math.max(0.0001, gainNode.gain.value), releaseAt);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, releaseAt + 0.26);
    source.stop(releaseAt + 0.3);
  };
}
