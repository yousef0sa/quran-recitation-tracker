// Mic capture and file decoding, both producing 16 kHz mono Float32.
export const TARGET_RATE = 16000;
/**
 * 150 ms at 16 kHz: the chunk size public/audio-processor.js posts from the mic and the bench default.
 * The bench chunk size is selectable (80 / 150 / 300 ms); splitIntoChunks takes it as a parameter.
 * The 150 ms value lives in three places: here, CHUNK_MS in live.ts and CHUNK_SAMPLES in audio-processor.js.
 */
export const CHUNK_SAMPLES = 2400;

export type MicChunkHandler = (samples: Float32Array, arrivalMs: number) => void;

export interface MicHandle {
  /** Actual AudioContext rate; 16000 unless the browser refused it (then the worklet resamples). */
  contextRate: number;
  stop(): void;
}

/** Error whose message is shown in the status line (Arabic first, English after). */
export class MicError extends Error {}

function describeMicError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "تم رفض إذن الميكروفون / Microphone permission was denied";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "لا يوجد ميكروفون متاح / No microphone available";
  }
  if (name === "NotReadableError") {
    return "الميكروفون مشغول بتطبيق آخر / The microphone is in use by another application";
  }
  return `تعذر تشغيل الميكروفون / Could not start the microphone: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Start capturing the mic. Call from a click handler (autoplay policy).
 * `onChunk` receives 150 ms chunks at 16 kHz; `arrivalMs` is performance.now() on arrival.
 */
export async function startMic(onChunk: MicChunkHandler): Promise<MicHandle> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    throw new MicError(describeMicError(err));
  }

  let context: AudioContext | null = null;
  try {
    let source: MediaStreamAudioSourceNode;
    try {
      context = new AudioContext({ sampleRate: TARGET_RATE });
      source = context.createMediaStreamSource(stream);
    } catch {
      // Some browsers refuse a 16 kHz context or a mic source at a foreign rate: use the device rate.
      await context?.close().catch(() => undefined);
      context = new AudioContext();
      source = context.createMediaStreamSource(stream);
    }
    if (context.state === "suspended") await context.resume();
    await context.audioWorklet.addModule(`${import.meta.env.BASE_URL}audio-processor.js`);
    const node = new AudioWorkletNode(context, "spike-audio-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
    });
    node.port.onmessage = (event: MessageEvent<{ samples: Float32Array }>) => {
      onChunk(event.data.samples, performance.now());
    };
    source.connect(node);
    const ctx = context;
    return {
      contextRate: ctx.sampleRate,
      stop() {
        try {
          source.disconnect();
          node.port.onmessage = null;
          node.disconnect();
        } finally {
          // Whatever fails above, the mic tracks must stop (the browser's mic indicator must go off).
          stream.getTracks().forEach((track) => track.stop());
          ctx.close().catch(() => {});
        }
      },
    };
  } catch (err) {
    stream.getTracks().forEach((track) => track.stop());
    await context?.close().catch(() => undefined);
    throw new MicError(describeMicError(err));
  }
}

/**
 * Decode an audio file to 16 kHz mono. The decoder resamples to the context rate
 * (single resample), then channels are averaged to mono.
 */
export async function decodeFileTo16kMono(file: Blob): Promise<Float32Array> {
  const bytes = await file.arrayBuffer();
  const context = new OfflineAudioContext(1, 1, TARGET_RATE);
  const decoded = await context.decodeAudioData(bytes);
  const mono = new Float32Array(decoded.length);
  const channels = decoded.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = decoded.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] as number) + (data[i] as number) / channels;
  }
  return mono;
}

/** Split samples into fixed-size copies (the last may be shorter; copies so they can be transferred to the worker). */
export function splitIntoChunks(samples: Float32Array, chunkSamples = CHUNK_SAMPLES): Float32Array[] {
  if (!(chunkSamples > 0)) throw new RangeError("chunkSamples must be positive");
  const chunks: Float32Array[] = [];
  for (let at = 0; at < samples.length; at += chunkSamples) {
    chunks.push(samples.slice(at, Math.min(samples.length, at + chunkSamples)));
  }
  return chunks;
}
