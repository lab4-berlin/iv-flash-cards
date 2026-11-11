// Multiple-choice distractor sampling (issue #31). Pure module: no DOM,
// no network; randomness is injected. Rules per design/multiple-choice.md:
// 3 distractors drawn randomly from *other* words of the same language,
// never duplicating the correct translation or each other; never padded
// with fakes — when a word can't get 3 valid distractors the whole mode
// is unavailable (the disabled "Choices" cell on Home).

/**
 * Distinct translations usable as distractors for `word`: drawn from other
 * same-language words, non-empty, different from the correct answer's
 * text, deduplicated.
 */
function candidates(words, word) {
  const seen = new Set([word.translation]);
  const pool = [];
  for (const other of words) {
    if (other === word) continue;
    if (other.language !== word.language) continue;
    const translation = other.translation;
    if (!translation || seen.has(translation)) continue;
    seen.add(translation);
    pool.push(translation);
  }
  return pool;
}

/** Whether a multiple-choice question can be built for `word` at all. */
export function canAsk(words, word) {
  return Boolean(word.translation) && candidates(words, word).length >= 3;
}

/**
 * Whether the Choices mode is offered: every word must be askable, so a
 * session (any subset of the vocabulary) can never hit a question with
 * fewer than 3 valid distractors mid-way. For a single-language vocabulary
 * with distinct translations this is exactly the issue's "at least 4 words
 * with distinct translations" rule.
 */
export function choicesAvailable(words) {
  return words.length > 0 && words.every((word) => canAsk(words, word));
}

/**
 * Pick 3 distractor translations for `correctWord`, uniformly at random
 * from the valid candidates (Maya's module contract). Returns null when
 * fewer than 3 exist — never pads with fakes.
 *
 * @param {Array} words - the whole vocabulary.
 * @param {object} correctWord - the word being asked.
 * @param {() => number} random - returns a float in [0, 1).
 * @returns {string[] | null} 3 distinct translations, or null.
 */
export function pick(words, correctWord, random) {
  if (!correctWord.translation) return null;
  const pool = candidates(words, correctWord);
  if (pool.length < 3) return null;
  // Partial Fisher–Yates: the first 3 positions of a full shuffle.
  for (let i = 0; i < 3; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3);
}

/**
 * Build one question: the correct translation + 3 distractors in random
 * order. Returns null when `pick` does (mode unavailable).
 *
 * @returns {{options: string[], correctIndex: number} | null}
 */
export function buildQuestion(words, correctWord, random) {
  const distractors = pick(words, correctWord, random);
  if (!distractors) return null;
  const options = [...distractors];
  const correctIndex = Math.floor(random() * 4);
  options.splice(correctIndex, 0, correctWord.translation);
  return { options, correctIndex };
}
