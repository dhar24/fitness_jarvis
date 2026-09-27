// Opens the mic, streams linear16 to Deepgram, and measures the only
// number that matters this weekend: how long after you stop speaking
// does the finalised transcript arrive.

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

const KEYTERMS = ["bhindi", "okra", "roti", "rotis", "chapati", "chapatis", "paratha", "parathas", "puri", "poori", "naan", "kulcha",
"dal", "daal", "sabzi", "sabji", "aloo", "gobi", "baingan", "palak", "matar", "rajma", "chole", "chana", "kadhi", "paneer",
"katori", "rice", "chawal", "khichdi", "biryani", "pulao", "pulav", "idli", "idlis", "dosa", "dosas", "uttapam", "upma", "poha",
"appam", "appe", "vada", "vadai", "medu vada", "sambar", "sambhar", "rasam", "chutney", "curd", "dahi", "yogurt", "raita",
"achar", "achaar", "papad", "pav", "bhaji", "pav bhaji", "bhatura", "bhature", "thepla", "dhokla", "khandvi", "misal", "thali",
"sevai", "sewai", "daliya", "bread", "toast", "sandwich", "omelette", "omelet", "egg", "eggs","protein"]

function socketUrl(sampleRate) {
  const params = new URLSearchParams({
    model: "nova-3",
    encoding: "linear16",
    sample_rate: String(sampleRate),
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    endpointing: "500",
    utterance_end_ms: "1000",
  });
  for (const term of KEYTERMS) params.append("keyterm", term);
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

export function createListener({ onState, onInterim, onFinal, onLevel, onError }) {
  let audioContext = null;
  let stream = null;
  let socket = null;
  let node = null;
  let streamStartedAt = 0;

  async function start() {
    try {
      onState("connecting");

      const tokenResp = await fetch(`${API_BASE}/api/stt/token`, { method: "POST" });
      if (!tokenResp.ok) throw new Error(`Token request failed (${tokenResp.status})`);
      const { key } = await tokenResp.json();

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      audioContext = new AudioContext();
      await audioContext.audioWorklet.addModule("/pcm-processor.js");

      socket = new WebSocket(socketUrl(audioContext.sampleRate), ["token", key]);
      socket.binaryType = "arraybuffer";

      socket.onopen = () => {
        onState("listening");

        const source = audioContext.createMediaStreamSource(stream);
        node = new AudioWorkletNode(audioContext, "pcm-processor");

        node.port.onmessage = (event) => {
          const { pcm, peak } = event.data;
          onLevel(peak);
          if (socket?.readyState === WebSocket.OPEN) {
            if (!streamStartedAt) streamStartedAt = performance.now();
            socket.send(pcm);
          }
        };

        source.connect(node);
        // Worklets need a destination to be pulled. Gain of zero keeps it silent.
        const mute = audioContext.createGain();
        mute.gain.value = 0;
        node.connect(mute).connect(audioContext.destination);
      };

      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type !== "Results") return;

        const text = msg.channel?.alternatives?.[0]?.transcript ?? "";
        if (!text) return;

        if (msg.is_final && msg.speech_final) {
          const audioEndMs = (msg.start + msg.duration) * 1000;
	  const latencyMs = Math.round(performance.now() - streamStartedAt - audioEndMs);
          onFinal({ text, latencyMs });
        } else if (!msg.is_final) {
          onInterim(text);
        }
      };

      socket.onerror = () => onError("Connection to the transcription service dropped.");
      socket.onclose = () => onState("idle");
    } catch (err) {
      onError(err.message ?? "Could not start listening.");
      onState("idle");
      await stop();
    }
  }

  async function stop() {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "CloseStream" }));
      socket.close();
    }
    socket = null;

    node?.port?.close();
    node?.disconnect();
    node = null;

    stream?.getTracks().forEach((track) => track.stop());
    stream = null;

    if (audioContext && audioContext.state !== "closed") await audioContext.close();
    audioContext = null;

    onLevel(0);
    onState("idle");
  }

  return { start, stop };
}
