// Speaking back.
//
// Browser speech synthesis rather than a hosted voice. It is free, needs no
// network round trip, and starts in tens of milliseconds where a hosted API
// costs 300 to 800ms. The voice is less polished. For a one-line answer read
// across a kitchen that is the right trade; if it grates later, swapping in a
// hosted voice touches only this file.
//
// Two browser quirks handled here:
//   1. iOS refuses to speak until synthesis has been triggered inside a real
//      user gesture, so prime() runs on the first button press.
//   2. Chrome loads its voice list asynchronously, so the preferred voice is
//      resolved lazily rather than once at import.

const PREFERRED_LANGS = ["en-IN", "en-GB", "en-AU", "en-US"];
const STORAGE_KEY = "speak-replies";

let primed = false;
let cachedVoice = null;

function supported() {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function isMuted() {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(STORAGE_KEY) === "off";
}

export function setMuted(muted) {
  try {
    localStorage.setItem(STORAGE_KEY, muted ? "off" : "on");
  } catch {
    // Private browsing. Falls back to speaking, which is the default.
  }
  if (muted) stop();
}

function pickVoice() {
  if (cachedVoice) return cachedVoice;
  if (!supported()) return null;

  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  for (const lang of PREFERRED_LANGS) {
    const exact = voices.find((v) => v.lang?.replace("_", "-") === lang);
    if (exact) {
      cachedVoice = exact;
      return exact;
    }
  }

  cachedVoice = voices.find((v) => v.lang?.startsWith("en")) ?? voices[0];
  return cachedVoice;
}

if (supported() && typeof window.speechSynthesis.addEventListener === "function") {
  window.speechSynthesis.addEventListener("voiceschanged", () => {
    cachedVoice = null;
    pickVoice();
  });
}

/** Call inside a real user gesture. iOS stays silent otherwise. */
export function prime() {
  if (primed || !supported()) return;
  try {
    const silent = new SpeechSynthesisUtterance("");
    silent.volume = 0;
    window.speechSynthesis.speak(silent);
    primed = true;
  } catch {
    // Nothing to recover; speech simply will not work on this device.
  }
}

export function stop() {
  if (!supported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Ignore.
  }
}

/** Speaks one short line. A new line always interrupts the previous one. */
export function say(text) {
  if (!text || !supported() || isMuted()) return;

  stop();

  const utterance = new SpeechSynthesisUtterance(String(text));
  const voice = pickVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }
  utterance.rate = 1.05;
  utterance.pitch = 1;

  try {
    window.speechSynthesis.speak(utterance);
  } catch {
    // Ignore.
  }
}

/** Turns a rendered answer into something worth hearing. */
export function answerToSpeech(answer) {
  if (!answer) return "";

  const raw = answer.say
    ? String(answer.say)
    : [answer.value, answer.unit, answer.label].filter(Boolean).join(" ");

  const clean = raw.replace(/\s+/g, " ").trim();
  const words = clean.split(" ");
  if (words.length <= SPEECH_WORD_CAP) return clean;

  // Cut at the last sentence boundary that fits, so it never ends mid-clause.
  const head = words.slice(0, SPEECH_WORD_CAP).join(" ");
  const lastStop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "));
  if (lastStop > 20) return head.slice(0, lastStop + 1);
  return `${head.replace(/[,;:]$/, "")}. The rest is on screen.`;
}

