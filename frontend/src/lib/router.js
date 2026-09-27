// Dispatches each entry in an envelope to the handler for its skill.
//
// The registry exists so that adding food, bodyweight, or later an ordering
// skill is a map entry rather than another branch in handleTranscript. One
// utterance can mix skills, so dispatch is per entry, not per utterance.

const handlers = new Map();

export function registerSkill(skill, handler) {
  handlers.set(skill, handler);
}

export function knownSkills() {
  return [...handlers.keys()];
}

/**
 * Runs every entry through its handler.
 * Returns { written, failed } so the caller can roll back optimistic rows
 * for the entries that failed without discarding the ones that succeeded.
 */
export async function dispatch(envelope) {
  const written = [];
  const failed = [];

  for (const entry of envelope.entries) {
    const handler = handlers.get(entry.skill);

    if (!handler) {
      failed.push({ entry, error: `No handler for "${entry.skill}"` });
      continue;
    }

    try {
      written.push(await handler(entry, envelope));
    } catch (err) {
      failed.push({ entry, error: err.message });
    }
  }

  return { written, failed };
}
