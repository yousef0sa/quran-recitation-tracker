// AudioWorklet: mono capture -> 16 kHz -> fixed-size chunks posted to the main thread.
// The chunk size is not defined here: src/audio.ts passes it as processorOptions.chunkSamples.
// The resampler is the same algorithm as src/resample.ts (worklets cannot import app modules):
// keep the two in sync. Continuous phase across blocks matters; a stateless per-block
// resampler drifts the tempo.

const TARGET_RATE = 16000;

class SpikeAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const chunkSamples = options && options.processorOptions && options.processorOptions.chunkSamples;
    if (!Number.isInteger(chunkSamples) || chunkSamples <= 0) {
      throw new Error("spike-audio-processor: processorOptions.chunkSamples must be a positive integer");
    }
    this.chunkSamples = chunkSamples;
    this.step = sampleRate / TARGET_RATE; // `sampleRate` is the AudioContext rate (worklet global)
    this.passthrough = sampleRate === TARGET_RATE;
    this.pos = 0; // next output position in input coordinates, relative to the current block
    this.prev = 0; // last sample of the previous block (index -1)
    this.buffer = new Float32Array(this.chunkSamples);
    this.filled = 0;
  }

  push(sample) {
    this.buffer[this.filled++] = sample;
    if (this.filled === this.chunkSamples) {
      const chunk = this.buffer;
      // contextTime: AudioContext time (s) at the end of the render quantum that completed the chunk.
      this.port.postMessage({ samples: chunk, contextTime: currentTime }, [chunk.buffer]);
      this.buffer = new Float32Array(this.chunkSamples);
      this.filled = 0;
    }
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    const n = channel.length;
    if (this.passthrough) {
      for (let i = 0; i < n; i++) this.push(channel[i]);
      return true;
    }
    while (this.pos <= n - 1) {
      const i0 = Math.floor(this.pos);
      const frac = this.pos - i0;
      const s0 = i0 < 0 ? this.prev : channel[i0];
      const s1 = i0 + 1 <= n - 1 ? channel[i0 + 1] : s0;
      this.push(s0 + (s1 - s0) * frac);
      this.pos += this.step;
    }
    this.pos -= n;
    this.prev = channel[n - 1];
    return true;
  }
}

registerProcessor("spike-audio-processor", SpikeAudioProcessor);
