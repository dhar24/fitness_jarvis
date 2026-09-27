# Grammar spec

The parser that keeps the model out of the hot path. Target: resolve 90% of
real utterances deterministically in under 5ms, with high precision. When it
is unsure it must say so rather than guess, because a wrong silent log is
worse than a one second delay.

## Output contract

Every parse returns this envelope, whether it came from the grammar or the
fallback. The router dispatches on `skill`, so later capabilities reuse it
unchanged.

```json
{
  "skill": "fitness",
  "intent": "log_activity",
  "slots": { "activity_key": "strength", "duration_min": 30, "level": "moderate" },
  "confidence": 0.94,
  "parsed_by": "grammar",
  "needs_confirmation": false,
  "raw": "log 30 minutes strength training"
}
```

Intents in scope: `log_activity`, `log_food`, `log_bodyweight`, `query_summary`,
`correct_last`, `undo_last`.

## Pipeline

1. **Normalise.** Lowercase, strip punctuation, collapse whitespace, expand
   contractions, map spoken numbers to digits ("forty five" to 45, "two and a
   half" to 2.5). Hindi and Hinglish quantity words map here too: "ek" to 1,
   "do" to 2, "dedh" to 1.5, "adha" to 0.5.
2. **Strip the lead verb.** `log`, `add`, `note`, `record`, `i did`, `i had`,
   `i ate`, `put down`, `mark`. Absence of a lead verb is not fatal, but it
   drops confidence by 0.1.
3. **Route by intent.** Question words (`how much`, `what did`, `did i`, `show`,
   `summary`, `total`) route to `query_summary` and leave the grammar entirely.
   Corrections (`no i meant`, `change that to`, `actually`) route to
   `correct_last`.
4. **Slot fill** against the activity or food patterns below.
5. **Score and guard.** Apply plausibility checks, then decide whether to
   write, confirm, or fall back.

## Activity patterns

Match in this order, first hit wins.

```
<duration> <unit> (of)? <activity>        45 minutes of cycling
<activity> (for)? <duration> <unit>       cycling for 45 minutes
<activity> <duration> <unit>              cycling 45 minutes
<distance> <dist_unit> <activity>         5 km run
<activity> <distance> <dist_unit>         ran 5 km
<count> <set_word> (of)? <activity>       3 sets of squats
<activity>                                went for a run
```

`<activity>` resolves against `activity_type.aliases` with exact match first,
then trigram similarity above 0.6. Below that, fall back.

Duration units: `minute`, `minutes`, `min`, `mins`, `hour`, `hours`, `hr`, `hrs`.
Distance units: `km`, `kilometre`, `kilometres`, `mile`, `miles`, `m`, `metres`.

Intensity modifiers, optional, default `moderate`: `easy`, `light`, `slow` map
to light. `hard`, `intense`, `heavy`, `fast`, `all out` map to vigorous.

Bare activity with no duration is valid. Set `duration_min` to null and
`needs_confirmation` to true, then ask once: "how long?"

## Food patterns

```
<qty> <unit> (of)? <food>                 two katoris of dal
<qty> <food>                              three idlis
<food>                                    dosa
<qty> <unit> (of)? <food> (and|with) ...  two rotis and a katori of sabzi
```

Split on `and`, `plus`, `with`, and commas, then parse each fragment
independently. One `log_entry` with several `food_detail` rows.

Quantity defaults to 1 when absent. Articles `a` and `an` mean 1.

Unit resolution order: food specific `portion_unit` row, then global
`portion_unit`, then plural inference (`rotis` means unit `piece`, qty from the
number). If no unit resolves and the food is countable, use `piece`.

Food resolution order, stop at first hit:

1. `user_food.spoken_alias` exact match for this user. Increment `hit_count`.
2. `food.aliases` array containment.
3. `food.name` trigram similarity above 0.55.
4. Vector similarity above 0.80.
5. Miss. Ask once, store the answer in `user_food`, never ask again.

Meal slot is inferred from clock time unless stated: before 11:00 breakfast,
11:00 to 16:00 lunch, 16:00 to 19:00 snack, after 19:00 dinner.

## Confidence scoring

Start at 1.0 and subtract:

| Condition | Penalty |
|---|---|
| No lead verb | 0.10 |
| Activity matched by trigram, not exact | 0.15 |
| Food matched by trigram | 0.15 |
| Food matched by vector only | 0.30 |
| Quantity inferred rather than stated | 0.10 |
| Unit inferred rather than stated | 0.10 |
| Any unconsumed tokens left over | 0.05 each, capped at 0.20 |

Thresholds:

- **0.80 and above.** Write immediately. Chime and confirm on screen.
- **0.55 to 0.79.** Write, but show an editable confirmation for 4 seconds.
- **Below 0.55.** Do not write. Send to the Haiku fallback.

## Plausibility guards

These fire before the write regardless of confidence, and they exist because
people misspeak units constantly.

| Check | Action |
|---|---|
| `duration_min` above 240 | Ask: did you mean minutes? |
| `duration_min` derived from hours and above 4 | Same ask |
| `duration_min` below 1 | Reject, ask again |
| Single food item resolving above 1500 kcal | Confirm before writing |
| Total quantity above 20 for a countable food | Confirm |
| `weight_kg` differing from last reading by more than 5 | Confirm |
| Timestamp more than 24h in the past with no date stated | Confirm the day |

A guard never silently corrects. It asks, or it writes what was said. Quietly
rewriting user input destroys trust in the log faster than any bug.

## Fallback contract

When confidence is below threshold, call Haiku with the normalised text, the
list of valid `activity_key` values, and the user's top 50 foods by
`hit_count`. Require the same envelope as output, with `parsed_by` set to
`haiku`. Reject any response whose `activity_key` or food id is not in the
provided lists rather than trusting it.

If the fallback also fails, write nothing, say "I did not catch that", and
insert a `parse_failure` row with the transcript and stage.

## Correction and undo

`correct_last` and `undo_last` operate on the most recent `log_entry` for this
user within the last 10 minutes. Corrections write a new entry with
`source = 'correction'` and soft delete the original, so the original
transcript survives for grammar improvement.

## How this improves

Read `parse_failure` weekly. Group by shape. Write rules for the two or three
most common shapes, not for one-off utterances. Precision over coverage: a
grammar that handles 85% of utterances correctly and defers the rest beats one
that handles 95% with occasional silent errors.
