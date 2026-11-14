// FAKE ASSISTANT. Stands in for a chat backend that doesn't exist yet.
// respond() takes what the person asked and returns { stream, attachment }:
//   stream      an async iterator of text chunks (the answer, typed out as it arrives)
//   attachment  optional extra shown under the answer: { type: "results", groups } or { type: "chart", ... }
// To go live, replace the body of respond() with a call to the real service; the chat screen stays unchanged.
// The numbers here line up with fake/api.js (Quantum computing: 1,906 versions since October 2002).

const STEP_MS = [14, 38];

export function respond({ mode, prompt, context, article, turn = 0 }) {
  const reply = turn > 0 ? followUp(turn) : REPLIES[mode]({ prompt, context, article });
  return { stream: typeOut(reply.text), attachment: reply.attachment ?? null };
}

const REPLIES = {
  ask: ({ context, article }) => ({
    text: context
      ? `That passage first appeared on 14 March 2019, in an edit by Mithril-Ghost called “Expand history section”. Before then, the article only said quantum computers “may one day” beat ordinary ones.

It has been reworded 6 times since. The biggest change came on 24 October 2019, a day after Google announced its Sycamore result: “could” became “has shown”. The wording you are reading now is from 3 November 2026, by Quantumavenger.

In short: this part of the article grew from a guess into a reported fact over about seven months.`
      : `${article.title} was started on 4 October 2002 and has been edited ${article.versions.toLocaleString("en-US")} times since. It began as three sentences comparing qubits to light switches.

The busiest year was 2019, with 214 edits, most of them about Google's Sycamore experiment. The article roughly doubled in length between 2018 and 2021.

The most recent edit was on 3 November 2026 by Quantumavenger, who updated the error-correction milestones.`,
  }),

  find: ({ context, article }) => ({
    text: context
      ? `This passage changed at 4 moments in the article's history. Three other articles say something close to it.`
      : `Here are the moments where ${article.title} changed the most, and the articles that link to it most often.`,
    attachment: {
      type: "results",
      groups: [
        {
          label: "In this article's history",
          items: [
            { title: "First added", meta: "14 Mar 2019 · Mithril-Ghost", note: "+412 characters in “History”" },
            { title: "“could” became “has shown”", meta: "24 Oct 2019 · Pkbwcgs", note: "After Google's Sycamore announcement" },
            { title: "Removed, then put back", meta: "2 Feb 2021 · 2601:646:c200::/64", note: "Reverted 6 minutes later by Auntof6" },
            { title: "Simplified wording", meta: "3 Nov 2026 · Quantumavenger", note: "Current version" },
          ],
        },
        {
          label: "Other articles",
          items: [
            { title: "Qubit", meta: "388 versions", note: "Says nearly the same thing in “Uses”" },
            { title: "Quantum mechanics", meta: "2,240 versions", note: "Links here from “Applications”" },
            { title: "Alan Turing", meta: "1,342 versions", note: "Compares it to ordinary computers" },
          ],
        },
      ],
    },
  }),

  visualise: ({ context, article }) => ({
    text: context
      ? `Here is how long ${article.title} was over time. The dot marks the day your passage first appeared.`
      : `Here is how long ${article.title} was over time, measured in characters.`,
    attachment: {
      type: "chart",
      title: `${article.title}, length in characters`,
      // One point per year: [year, characters]. The real data would come from /api/article at each date.
      series: [
        [2002, 1200], [2003, 1450], [2004, 2100], [2005, 2300], [2006, 3100], [2007, 3900],
        [2008, 4200], [2009, 4100], [2010, 5200], [2011, 5600], [2012, 6900], [2013, 7400],
        [2014, 7300], [2015, 8800], [2016, 9600], [2017, 10400], [2018, 11200], [2019, 16900],
        [2020, 19400], [2021, 22800], [2022, 23500], [2023, 24900], [2024, 26100], [2025, 27400],
        [2026, 28200],
      ],
      marker: context ? { at: 2019.2, label: "Your passage added" } : null,
    },
  }),
};

const FOLLOW_UPS = [
  `Good question. The edit history shows it was mostly two people: Mithril-Ghost wrote the first version, and Quantumavenger has kept it up to date since 2023. Between them they made 61% of all changes to this section.`,
  `Yes. If you go back to January 2019, the sentence isn't there at all. The section was only two short paragraphs then, and it didn't mention Google or IBM.`,
  `I can't tell for sure who added the original source, because that edit has no summary. The reference itself points to a 2019 article in Nature.`,
];

function followUp(turn) {
  return { text: FOLLOW_UPS[(turn - 1) % FOLLOW_UPS.length] };
}

async function* typeOut(text) {
  await wait(520);
  for (const piece of text.match(/\S+\s*|\s+/g)) {
    await wait(STEP_MS[0] + Math.random() * (STEP_MS[1] - STEP_MS[0]));
    yield piece;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Chats from earlier visits, shown under History. A live version would load the person's saved chats.
export const PAST_CHATS = [
  {
    title: "When was the History section added?",
    label: "Ask",
    when: "Yesterday",
    messages: [
      { role: "user", text: "When was the History section added?" },
      {
        role: "ai",
        text: `The History section was added on 9 June 2011 by Auntof6. It started as four sentences about Richard Feynman's 1981 talk on simulating physics with computers.

It has been edited 312 times since, about one in six of all edits to the article.`,
      },
    ],
  },
  {
    title: "Edits by Quantumavenger",
    label: "Find",
    when: "3 Nov",
    messages: [
      { role: "user", text: "Edits by Quantumavenger" },
      {
        role: "ai",
        text: `Quantumavenger has edited this article 41 times since March 2023, mostly in “State of affairs” and “Engineering”.

Their latest edit, on 3 November 2026, updated the error-correction milestones.`,
      },
    ],
  },
  {
    title: "Show edits per year",
    label: "Visualise",
    when: "28 Oct",
    messages: [
      { role: "user", text: "Show edits per year" },
      { role: "ai", text: "2019 was the busiest year with 214 edits, followed by 2021 with 167. Before 2010 the article saw fewer than 40 edits a year." },
    ],
  },
];
