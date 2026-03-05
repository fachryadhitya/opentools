import {
  answerFromFacts,
  detectQuestionIntent,
  embedTexts,
  extractFactsFromContext,
  verifyAnswerFromFacts,
} from "./openai-client";
import {
  findPeopleByNameQuery,
  getContextChunks,
  getHybridChunkIds,
  getHybridChunkIdsForPeople,
} from "./retrieval";

const ASK_TOPK_GENERAL = Number(Bun.env.ASK_TOPK_GENERAL ?? "18");
const ASK_TOPK_AGGREGATE = Number(Bun.env.ASK_TOPK_AGGREGATE ?? "60");
const ASK_MAX_FACTS_GENERAL = Number(Bun.env.ASK_MAX_FACTS_GENERAL ?? "24");
const ASK_MAX_FACTS_AGGREGATE = Number(Bun.env.ASK_MAX_FACTS_AGGREGATE ?? "80");

export type AskProgressEvent = {
  type: "stage" | "trace";
  message: string;
};

type AskProgressCallback = (event: AskProgressEvent) => void;

function emitProgress(
  onProgress: AskProgressCallback | undefined,
  event: AskProgressEvent,
) {
  if (!onProgress) return;
  onProgress(event);
}

function createThoughtEmitter(
  onProgress: AskProgressCallback | undefined,
  phase: string,
) {
  const seen = new Set<string>();

  return (thought: string) => {
    const message = `[${phase}] ${thought.trim()}`;
    if (!message || seen.has(message)) return;
    seen.add(message);
    emitProgress(onProgress, { type: "trace", message });
  };
}

function formatContext(
  chunks: Array<{
    id: number;
    personName: string;
    profileUrl: string;
    pageUrl: string;
    chunkText: string;
  }>,
) {
  return chunks
    .map((chunk) =>
      [
        `[${chunk.id}] ${chunk.personName}`,
        `Profile: ${chunk.profileUrl}`,
        `Page: ${chunk.pageUrl}`,
        `Snippet: ${chunk.chunkText}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export async function askUses(
  question: string,
  onProgress?: AskProgressCallback,
) {
  emitProgress(onProgress, {
    type: "stage",
    message: "Classifying your question...",
  });

  const [intent, [queryEmbedding]] = await Promise.all([
    detectQuestionIntent(
      question,
      createThoughtEmitter(onProgress, "Intent Reasoning"),
    ),
    embedTexts([question]),
  ]);

  const isPersonQuestion = intent.intent === "person_specific";
  const topK = intent.asksAggregate ? ASK_TOPK_AGGREGATE : ASK_TOPK_GENERAL;
  const maxFacts = intent.asksAggregate
    ? ASK_MAX_FACTS_AGGREGATE
    : ASK_MAX_FACTS_GENERAL;
  const likelyPeople = isPersonQuestion
    ? findPeopleByNameQuery(intent.targetPerson || question, 2)
    : [];

  if (isPersonQuestion && likelyPeople.length === 0) {
    const label = intent.targetPerson || "that person";
    return {
      answer: `I couldn't find indexed /uses content for **${label}**. Try re-seeding, or confirm that person exists in the indexed directory.`,
      citations: [],
    };
  }

  emitProgress(onProgress, {
    type: "stage",
    message: "Retrieving evidence snippets...",
  });

  const targetedChunkIds = getHybridChunkIdsForPeople(
    question,
    queryEmbedding,
    likelyPeople.map((person) => person.id),
    topK,
  );

  const chunkIds =
    isPersonQuestion || targetedChunkIds.length > 0
      ? targetedChunkIds
      : getHybridChunkIds(question, queryEmbedding, topK);
  const contextChunks = getContextChunks(chunkIds);

  if (contextChunks.length === 0) {
    const maybePerson =
      likelyPeople.length > 0 ? ` for ${likelyPeople[0].name}` : "";
    return {
      answer: `I couldn't find relevant indexed /uses content${maybePerson} yet. Run the seed script first.`,
      citations: [],
    };
  }

  const numberedChunks = contextChunks.map((chunk, index) => ({
    ...chunk,
    id: index + 1,
  }));
  const finalContextChunks = numberedChunks;
  const context = formatContext(finalContextChunks);

  emitProgress(onProgress, {
    type: "stage",
    message: "Extracting grounded facts...",
  });

  const extracted = await extractFactsFromContext(
    question,
    context,
    createThoughtEmitter(onProgress, "Fact Extraction Reasoning"),
  );
  if (extracted.reasoning) {
    emitProgress(onProgress, {
      type: "trace",
      message: `[Fact Extraction Reasoning] ${extracted.reasoning}`,
    });
  }
  const relevantFacts = extracted.facts
    .filter(
      (fact) => fact.chunkId >= 1 && fact.chunkId <= finalContextChunks.length,
    )
    .filter((fact) => fact.relevance >= (intent.asksAggregate ? 0.35 : 0.45))
    .slice(0, maxFacts);

  if (relevantFacts.length === 0) {
    return {
      answer:
        "I couldn't find enough directly supported evidence in the indexed snippets to answer confidently.",
      citations: [],
    };
  }

  emitProgress(onProgress, {
    type: "stage",
    message: "Drafting answer...",
  });

  const draft = await answerFromFacts(
    question,
    relevantFacts,
    createThoughtEmitter(onProgress, "Answer Reasoning"),
  );
  const strictVerify = Bun.env.ASK_STRICT_VERIFY === "1";

  const shouldVerify =
    strictVerify &&
    (isPersonQuestion || intent.asksBest || intent.asksCurrentUse);

  const modelResult = shouldVerify
    ? await (async () => {
        emitProgress(onProgress, {
          type: "stage",
          message: "Verifying citations...",
        });
        return verifyAnswerFromFacts(
          question,
          relevantFacts,
          draft,
          createThoughtEmitter(onProgress, "Verification Reasoning"),
        );
      })()
    : draft;
  const citedIds = new Set(
    modelResult.citations.filter(
      (id) => id >= 1 && id <= finalContextChunks.length,
    ),
  );
  const citations = finalContextChunks
    .map((chunk) => ({
      id: chunk.id,
      person: chunk.personName,
      profileUrl: chunk.profileUrl,
      pageUrl: chunk.pageUrl,
      excerpt:
        chunk.chunkText.length > 240
          ? `${chunk.chunkText.slice(0, 237)}...`
          : chunk.chunkText,
    }))
    .filter((citation) => citedIds.has(citation.id));

  return {
    answer: modelResult.answer,
    citations,
  };
}
