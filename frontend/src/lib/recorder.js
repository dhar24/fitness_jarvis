// Push to talk. Records a clip, sends it whole for transcription.
//
// Format matters more than it looks: iOS Safari cannot record audio/webm and
// throws on an unsupported mimeType, so we ask the browser what it can do
// rather than assuming. Whisper accepts everything in the list.

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

const CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",          // Safari, desktop and iOS
  "audio/mp4;codecs=mp4a.40.2",
  "audio/ogg;codecs=opus",
];

const MAX_CLIP_MS = 60000;

function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of CANDIDATES) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return "";
}

function extensionFor(mime) {
  if (!mime) return "webm";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

export function createRecorder({ onState, onFinal, onLevel, onError }) {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let releasedAt = 0;
  let stopMeter = null;
  let capTimer = null;
  let mime = null;

  async function warm() {
    if (stream && stream.active) return stream;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    return stream;
  }

  function startMeter(src) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return () => {};

    const ctx = new Ctx();
    // iOS starts contexts suspended until a gesture resumes them.
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    ctx.createMediaStreamSource(src).connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);

    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
      onLevel(peak);
    }, 50);

    return () => {
      clearInterval(timer);
      ctx.close().catch(() => {});
      onLevel(0);
    };
  }

  async function press() {
    if (recorder) return;
    try {
      onState("recording");
      const src = await warm();
      stopMeter = startMeter(src);

      mime = pickMime();
      if (mime === null) throw new Error("This browser cannot record audio.");

      chunks = [];
      recorder = mime ? new MediaRecorder(src, { mimeType: mime }) : new MediaRecorder(src);
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = send;
      recorder.start();

      // Safety net: a stuck finger or a missed pointerup must not record forever.
      capTimer = setTimeout(release, MAX_CLIP_MS);
    } catch (err) {
      onError(err.message ?? "Could not start the mic.");
      onState("idle");
      recorder = null;
    }
  }

  function release() {
    if (!recorder) return;
    clearTimeout(capTimer);
    capTimer = null;
    releasedAt = performance.now();
    stopMeter?.();
    stopMeter = null;
    if (recorder.state === "recording") recorder.stop();
    recorder = null;
    onState("sending");
  }

  async function send() {
    try {
      const blob = new Blob(chunks, { type: mime || "audio/webm" });
      if (blob.size < 2000) {
        onState("idle");
        return;
      }

      const body = new FormData();
      body.append("audio", blob, `clip.${extensionFor(mime)}`);

      const resp = await fetch(`${API_BASE}/api/stt/transcribe`, { method: "POST", body });
      if (!resp.ok) throw new Error(`Transcription failed (${resp.status})`);

      const { text } = await resp.json();
      if (text) onFinal({ text, latencyMs: Math.round(performance.now() - releasedAt) });
    } catch (err) {
      onError(err.message ?? "Could not transcribe that.");
    } finally {
      onState("idle");
    }
  }

  return { press, release };
}
