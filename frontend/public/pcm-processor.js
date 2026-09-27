// Runs on the audio thread. Converts float32 samples to linear16 and ships
// them in ~20ms chunks. Small chunks keep the tail of an utterance short,
// which is most of what determines how fast the final transcript lands.

const QUANTA_PER_CHUNK = 8; // 8 x 128 samples ~= 21ms at 48kHz

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.quanta = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    this.buffer.push(new Float32Array(channel));
    this.quanta += 1;

    if (this.quanta < QUANTA_PER_CHUNK) return true;

    const total = this.buffer.reduce((n, b) => n + b.length, 0);
    const pcm = new Int16Array(total);
    let peak = 0;
    let offset = 0;

    for (const block of this.buffer) {
      for (let i = 0; i < block.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, block[i]));
        if (sample > peak) peak = sample;
        pcm[offset + i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      offset += block.length;
    }

    this.port.postMessage({ pcm: pcm.buffer, peak }, [pcm.buffer]);
    this.buffer = [];
    this.quanta = 0;
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
