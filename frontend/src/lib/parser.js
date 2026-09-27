// Deterministic activity grammar. Runs in the browser, no network, no model.
// Returns the envelope defined in GRAMMAR.md. When it is unsure it says so
// rather than guessing, because a wrong silent log is worse than a question.

const NUMBER_WORDS = {
 zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
 eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
 fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
 nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
 sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
 ek: 1, do: 2, teen: 3, char: 4, paanch: 5, panch: 5,
 a: 1, an: 1, half: 0.5, adha: 0.5, dedh: 1.5,
};

const ACTIVITIES = [
 { key: "strength", aliases: ["strength training", "strength", "weights", "weight training", "gym", "lifting", "resistance", "weight lifting"] },
 { key: "hiit", aliases: ["hiit", "intervals", "interval training", "circuit", "circuits"] },
 { key: "running", aliases: ["running", "run", "ran", "jog", "jogging", "treadmill"] },
 { key: "cycling", aliases: ["cycling", "cycle", "cycled", "bike", "biking", "biked", "spinning"] },
 { key: "swimming", aliases: ["swimming", "swim", "swam"] },
 { key: "walking", aliases: ["walking", "walk", "walked", "steps"] },
 { key: "yoga", aliases: ["yoga", "stretching", "stretch", "mobility"] },
 { key: "sports", aliases: ["badminton", "football", "cricket", "tennis", "squash", "basketball"] },
 { key: "housework", aliases: ["housework", "cleaning", "chores", "gardening"] },
 { key: "cardio", aliases: ["cardio", "conditioning", "elliptical", "rowing"] },
];

const LEAD_VERBS = [
 "log", "add", "note", "record", "put down", "mark",
 "i did", "i have done", "i've done", "did", "i went for", "went for",
];

const INTENSITY = {
 light: ["easy", "light", "slow", "gentle"],
 vigorous: ["hard", "intense", "heavy", "fast", "all out", "vigorous"],
};

const QUERY_STARTS = [
 "how much", "how many", "how long", "what did", "what have", "did i",
 "show", "summary", "total", "give me", "tell me",
];

function wordsToNumber(text) {
 return text.replace(
 /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|fourty|forty|fifty|sixty|seventy|eighty|ninety|hundred|ek|do|teen|char|paanch|panch|half|adha|dedh)(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?\b/g,
 (match) => {
 const parts = match.split(/[\s-]+/);
 let total = 0;
 for (const part of parts) {
 const value = NUMBER_WORDS[part];
 if (value === undefined) return match;
 total += value;
 }
 return String(total);
 }
 );
}

export function normalise(raw) {
 let text = raw.toLowerCase().trim();
 text = text.replace(/[.,!?;:]/g, " ");
 text = text.replace(/\bmins?\b/g, "minutes");
 text = text.replace(/\bhrs?\b/g, "hours");
 text = text.replace(/\bkms?\b/g, "km");
 text = wordsToNumber(text);
 return text.replace(/\s+/g, " ").trim();
}

function stripLeadVerb(text) {
 for (const verb of LEAD_VERBS) {
 if (text.startsWith(verb + " ")) {
 return { text: text.slice(verb.length + 1).replace(/^of\s+/, ""), found: true };
 }
 }
 return { text, found: false };
}

function findActivity(text) {
 let best = null;

 for (const activity of ACTIVITIES) {
 for (const alias of activity.aliases) {
 const at = text.indexOf(alias);
 if (at === -1) continue;

 const before = at === 0 || /\s/.test(text[at - 1]);
 const afterIdx = at + alias.length;
 const after = afterIdx === text.length || /\s/.test(text[afterIdx]);
 if (!before || !after) continue;

 if (!best || alias.length > best.alias.length) {
 best = { key: activity.key, alias, at };
 }
 }
 }

 return best;
}

function findIntensity(text) {
 for (const [level, words] of Object.entries(INTENSITY)) {
 for (const word of words) {
 if (new RegExp(`\\b${word}\\b`).test(text)) return level;
 }
 }
 return null;
}



const FILLER = new Set([
 "i","a","an","the","of","for","and","then","also","plus","with","my","some",
 "did","do","done","had","have","has","was","were","went","got","to","in","on",
 "at","today","morning","afternoon","evening","night","yesterday","just","about",
 "around","approximately","minutes","hours","km","mile","miles","metres","meters",
 "easy","light","slow","gentle","hard","intense","heavy","fast","vigorous","out",
]);

// The grammar only knows activities. If meaningful words are left over after
// consuming the activity and its duration, the sentence contains something
// else (usually food), so hand the whole thing to the model rather than
// silently logging half of it.
function hasLeftovers(body, consumed) {
 let rest = body;
 for (const part of consumed) {
 if (part) rest = rest.replace(part, " ");
 }
 return rest
 .split(/\s+/)
 .map((w) => w.replace(/[^a-z]/g, ""))
 .some((w) => w.length >= 3 && !FILLER.has(w));
}



export function parse(raw) {
  const envelope = {
    skill: "fitness",
    intent: null,
    entries: [],
    confidence: 0,
    parsed_by: "grammar",
    needs_confirmation: false,
    question: null,
    raw,
  };

  const text = normalise(raw);
  if (!text) return { ...envelope, intent: "unknown" };

  if (QUERY_STARTS.some((q) => text.startsWith(q))) {
    return { ...envelope, intent: "query_summary", confidence: 0.9 };
  }

  if (/^(no|actually|i meant|change that)\b/.test(text)) {
    return { ...envelope, intent: "correct_last", confidence: 0.9 };
  }

  if (/\b(undo|delete that|remove that|scratch that)\b/.test(text)) {
    return { ...envelope, intent: "undo_last", confidence: 0.95 };
  }

  const stripped = stripLeadVerb(text);
  const body = stripped.text;

  const activity = findActivity(body);
  if (!activity) {
    return { ...envelope, intent: "unknown", question: "Which activity was that?" };
  }

  // More than one activity in one sentence. The grammar handles exactly one,
  // so hand off rather than guess which number belongs to which activity.
  if (countActivities(body) > 1) {
    return { ...envelope, intent: "unknown", question: null };
  }

  let confidence = 1.0;
  if (!stripped.found) confidence -= 0.1;

  const entry = {
    skill: "activity",
    activity_key: activity.key,
    duration_min: null,
    distance_km: null,
    level: "moderate",
  };
  
  const durationMatch = body.match(/(\d+(?:\.\d+)?)\s*(minutes|hours)\b/);
  const distanceMatch = body.match(/(\d+(?:\.\d+)?)\s*(km|miles?|metres?)\b/);

  let statedUnit = null;

  if (durationMatch) {
    const value = parseFloat(durationMatch[1]);
    statedUnit = durationMatch[2];
    entry.duration_min = statedUnit === "hours" ? Math.round(value * 60) : Math.round(value);
  } else {
    const bare = body.match(/\b(\d+(?:\.\d+)?)\b/);
    if (bare && !distanceMatch) {
      entry.duration_min = Math.round(parseFloat(bare[1]));
      confidence -= 0.1;
    }
  }

  if (distanceMatch) {
    const value = parseFloat(distanceMatch[1]);
    const unit = distanceMatch[2];
    entry.distance_km = unit.startsWith("mile") ? value * 1.609 : unit.startsWith("met") ? value / 1000 : value;
  }

  const level = findIntensity(body);
  entry.level = level ?? "moderate";
  if (!level) confidence -= 0.02;

  if (entry.duration_min == null && entry.distance_km == null) {
    return {
      ...envelope,
      intent: "log_activity",
      entries: [entry],
      confidence: Math.max(confidence - 0.3, 0),
      needs_confirmation: true,
      question: "How long was that?",
    };
  }

  const guard = plausibility(entry, statedUnit);
  if (guard) {
    return {
      ...envelope,
      intent: "log_activity",
      entries: [entry],
      confidence,
      needs_confirmation: true,
      question: guard,
    };
  }

const consumed = [activity.alias, durationMatch?.[0], distanceMatch?.[0], level];
 if (hasLeftovers(body, consumed)) {
 return { ...envelope, intent: "unknown", question: null };
 }

 return {
 ...envelope,
 intent: "log_activity",
 entries: [entry],
 confidence: Math.round(Math.max(confidence, 0) * 100) / 100,
 needs_confirmation: confidence < 0.8,
 };
}

function plausibility(entry, statedUnit) {
  const mins = entry.duration_min;
  if (mins == null) return null;
  if (mins < 1) return "That came out under a minute. How long was it really?";
  if (statedUnit === "hours" && mins > 240) return `That is ${mins / 60} hours. Did you mean minutes?`;
  if (mins > 240) return `That is ${mins} minutes. Is that right?`;
  return null;
}

function countActivities(text) {
  const found = new Set();
  for (const activity of ACTIVITIES) {
    for (const alias of activity.aliases) {
      if (new RegExp(`\\b${alias}\\b`).test(text)) {
        found.add(activity.key);
        break;
      }
    }
  }
  return found.size;
}

export const ACTIVITY_KEYS = ACTIVITIES.map((a) => a.key);

export const ACTIVITY_LABELS = Object.fromEntries(
  ACTIVITIES.map((a) => [a.key, a.aliases[0].replace(/\b\w/, (c) => c.toUpperCase())])
);
