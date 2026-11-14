// Masks slurs that attack people for their race, ethnicity, religion, sexuality, gender identity or
// disability: the first letter stays, the rest become asterisks. Ordinary swearing is left alone.
const SLURS = new RegExp(
  "\\b(" +
    [
      "nigg(?:er|a|ah|az|uh)s?",
      "niggers?",
      "negro(?:e?s)?",
      "kikes?",
      "spics?",
      "spiks?",
      "chinks?",
      "gooks?",
      "wetbacks?",
      "beaners?",
      "pakis?",
      "ragheads?",
      "towelheads?",
      "sand ?niggers?",
      "coons?",
      "jungle ?bunn(?:y|ies)",
      "gypp?os?",
      "faggots?",
      "fags?",
      "dykes?",
      "trann(?:y|ies)",
      "shemales?",
      "retards?",
      "retarded",
    ].join("|") +
    ")\\b",
  "gi",
);

export function censor(text) {
  return text.replace(SLURS, (word) => word[0] + word.slice(1).replace(/[^\s]/g, "*"));
}
