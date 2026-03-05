import {
  GoogleGenAI,
  ThinkingLevel,
} from "@google/genai";
import OpenAI from "openai";

const embeddingProvider = (
  Bun.env.EMBEDDING_PROVIDER ?? "openai"
).toLowerCase();
const llmProvider = (
  Bun.env.LLM_PROVIDER ?? (Bun.env.GEMINI_API_KEY ? "gemini" : "openai")
).toLowerCase();

export const embedModel =
  Bun.env.OPENAI_EMBED_MODEL ??
  (embeddingProvider === "gemini"
    ? "text-embedding-004"
    : "text-embedding-3-small");
export const chatModel =
  Bun.env.OPENAI_CHAT_MODEL ??
  (llmProvider === "gemini" ? "gemini-3-flash-preview" : "gpt-4.1-mini");
export const verifyModel = Bun.env.OPENAI_VERIFY_MODEL ?? chatModel;
export const screenModel = Bun.env.OPENAI_SCREEN_MODEL ?? chatModel;
export const extractModel = Bun.env.OPENAI_EXTRACT_MODEL ?? verifyModel;

let embeddingClient: OpenAI | null = null;
let openaiLLMClient: OpenAI | null = null;
let geminiLLMClient: GoogleGenAI | null = null;

function getOpenAIClientForPurpose(purpose: "embedding" | "llm") {
  const apiKey = Bun.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      `OPENAI_API_KEY is required for ${purpose} provider 'openai'.`,
    );
  }

  return new OpenAI({
    apiKey,
    baseURL: Bun.env.OPENAI_BASE_URL,
  });
}

function getEmbeddingClient() {
  if (embeddingProvider !== "openai") {
    throw new Error(
      `Unsupported EMBEDDING_PROVIDER '${embeddingProvider}'. Use 'openai' for embeddings.`,
    );
  }

  if (embeddingClient) return embeddingClient;
  embeddingClient = getOpenAIClientForPurpose("embedding");
  return embeddingClient;
}

function getOpenAILLMClient() {
  if (openaiLLMClient) return openaiLLMClient;
  openaiLLMClient = getOpenAIClientForPurpose("llm");
  return openaiLLMClient;
}

function getGeminiLLMClient() {
  if (geminiLLMClient) return geminiLLMClient;

  const apiKey = Bun.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required for llm provider 'gemini'.");
  }

  geminiLLMClient = new GoogleGenAI({
    apiKey,
    apiVersion: Bun.env.GEMINI_API_VERSION,
  });
  return geminiLLMClient;
}

function getGeminiThinkingLevel() {
  const raw = (Bun.env.GEMINI_THINKING_LEVEL ?? "low").toLowerCase();

  if (raw === "minimal") return ThinkingLevel.MINIMAL;
  if (raw === "medium") return ThinkingLevel.MEDIUM;
  if (raw === "high") return ThinkingLevel.HIGH;
  if (raw === "low") return ThinkingLevel.LOW;

  return ThinkingLevel.LOW;
}

export type ModelAnswer = {
  answer: string;
  citations: number[];
};

export type ContextScreenResult = {
  keepIds: number[];
};

export type ExtractedFact = {
  chunkId: number;
  personName: string;
  fact: string;
  evidenceSentence: string;
  isCurrent: boolean;
  relevance: number;
};

export type QuestionIntent = {
  intent: "person_specific" | "general";
  targetPerson: string;
  asksCurrentUse: boolean;
  asksBest: boolean;
  asksAggregate: boolean;
};

export type ModelThoughtCallback = (thought: string) => void;

type StructuredChatResult = {
  content: string;
  thoughts: string[];
};

function uniquePositiveInts(value: unknown) {
  if (!Array.isArray(value)) return [];

  const ints = value.filter(
    (item): item is number => Number.isInteger(item) && item > 0,
  );
  return [...new Set(ints)];
}

function cleanJsonText(raw: string) {
  const text = raw.trim();
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function clampRelevance(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function parseModelAnswer(raw: string): ModelAnswer {
  const text = raw.trim();
  const jsonText = cleanJsonText(raw);

  try {
    const parsed = JSON.parse(jsonText) as {
      answer?: unknown;
      citations?: unknown;
    };

    const answer =
      typeof parsed.answer === "string" && parsed.answer.trim()
        ? parsed.answer.trim()
        : "I couldn't produce an answer.";

    const citations = uniquePositiveInts(parsed.citations);

    return { answer, citations };
  } catch {
    const citations = [...text.matchAll(/\[(\d+)\]/g)]
      .map((match) => Number(match[1]))
      .filter((id) => Number.isInteger(id) && id > 0);

    return {
      answer: text || "I couldn't produce an answer.",
      citations: [...new Set(citations)],
    };
  }
}

function parseContextScreenResult(raw: string): ContextScreenResult {
  const jsonText = cleanJsonText(raw);

  try {
    const parsed = JSON.parse(jsonText) as {
      keep_ids?: unknown;
      keepIds?: unknown;
    };
    const keepIds = uniquePositiveInts(parsed.keep_ids ?? parsed.keepIds);
    return { keepIds };
  } catch {
    return { keepIds: [] };
  }
}

function parseFactsResult(raw: string): {
  facts: ExtractedFact[];
  reasoning: string;
} {
  const jsonText = cleanJsonText(raw);

  try {
    const parsed = JSON.parse(jsonText) as {
      reasoning?: unknown;
      facts?: Array<{
        chunk_id?: unknown;
        person_name?: unknown;
        fact?: unknown;
        evidence_sentence?: unknown;
        is_current?: unknown;
        relevance?: unknown;
      }>;
    };

    const facts = (parsed.facts ?? [])
      .map((fact) => {
        const chunkId =
          typeof fact.chunk_id === "number" ? Math.trunc(fact.chunk_id) : -1;
        const personName =
          typeof fact.person_name === "string" ? fact.person_name.trim() : "";
        const factText = typeof fact.fact === "string" ? fact.fact.trim() : "";
        const evidenceSentence =
          typeof fact.evidence_sentence === "string"
            ? fact.evidence_sentence.trim()
            : "";

        return {
          chunkId,
          personName,
          fact: factText,
          evidenceSentence,
          isCurrent: fact.is_current === true,
          relevance: clampRelevance(fact.relevance),
        };
      })
      .filter(
        (fact) =>
          fact.chunkId > 0 &&
          fact.fact.length > 0 &&
          fact.evidenceSentence.length > 0,
      );

    const dedup = new Map<string, ExtractedFact>();
    for (const fact of facts) {
      const key = `${fact.chunkId}:${fact.fact.toLowerCase()}`;
      if (!dedup.has(key)) dedup.set(key, fact);
    }

    const reasoning =
      typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : "";

    return { facts: [...dedup.values()], reasoning };
  } catch {
    return { facts: [], reasoning: "" };
  }
}

function parseQuestionIntent(raw: string): QuestionIntent {
  const jsonText = cleanJsonText(raw);

  try {
    const parsed = JSON.parse(jsonText) as {
      intent?: unknown;
      target_person?: unknown;
      asks_current_use?: unknown;
      asks_best?: unknown;
      asks_aggregate?: unknown;
    };

    const intent =
      parsed.intent === "person_specific" ? "person_specific" : "general";
    const targetPerson =
      typeof parsed.target_person === "string"
        ? parsed.target_person.trim()
        : "";

    return {
      intent,
      targetPerson,
      asksCurrentUse: parsed.asks_current_use === true,
      asksBest: parsed.asks_best === true,
      asksAggregate: parsed.asks_aggregate === true,
    };
  } catch {
    return {
      intent: "general",
      targetPerson: "",
      asksCurrentUse: false,
      asksBest: false,
      asksAggregate: false,
    };
  }
}

function normalizeThoughtText(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > 280 ? `${compact.slice(0, 277)}...` : compact;
}

function buildGeminiPrompt(
  messages: Array<{ role: "system" | "user"; content: string }>,
) {
  return messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
}

async function structuredChat(
  model: string,
  temperature: number,
  _schemaName: string,
  schema: Record<string, unknown>,
  messages: Array<{ role: "system" | "user"; content: string }>,
  onThought?: ModelThoughtCallback,
): Promise<StructuredChatResult> {
  if (llmProvider === "gemini") {
    const stream = await getGeminiLLMClient().models.generateContentStream({
      model,
      contents: buildGeminiPrompt(messages),
      config: {
        temperature,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: getGeminiThinkingLevel(),
        },
      },
    });

    let answerSnapshot = "";
    let content = "";
    let thoughtSnapshot = "";
    let thoughtBuffer = "";
    const thoughts: string[] = [];

    const emitThought = (text: string) => {
      const normalized = normalizeThoughtText(text);
      if (!normalized) return;
      thoughts.push(normalized);
      onThought?.(normalized);
    };

    for await (const chunk of stream) {
      const currentAnswer = chunk.text ?? "";
      if (currentAnswer) {
        if (currentAnswer.startsWith(answerSnapshot)) {
          content += currentAnswer.slice(answerSnapshot.length);
        } else {
          content += currentAnswer;
        }
        answerSnapshot = currentAnswer;
      }

      const chunkThought = (chunk.candidates?.[0]?.content?.parts ?? [])
        .filter(
          (part): part is { thought: true; text: string } =>
            part.thought === true && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("");
      if (!chunkThought) continue;

      let thoughtDelta = chunkThought;
      if (chunkThought.startsWith(thoughtSnapshot)) {
        thoughtDelta = chunkThought.slice(thoughtSnapshot.length);
      }
      if (chunkThought.length > thoughtSnapshot.length) {
        thoughtSnapshot = chunkThought;
      }
      if (!thoughtDelta.trim()) continue;

      thoughtBuffer += thoughtDelta;
      const punctuationIdx = Math.max(
        thoughtBuffer.lastIndexOf(". "),
        thoughtBuffer.lastIndexOf("! "),
        thoughtBuffer.lastIndexOf("? "),
        thoughtBuffer.lastIndexOf("\n"),
      );
      if (punctuationIdx >= 0 || thoughtBuffer.length >= 180) {
        const chunkToEmit =
          punctuationIdx >= 0 ? thoughtBuffer.slice(0, punctuationIdx + 1) : thoughtBuffer;
        thoughtBuffer =
          punctuationIdx >= 0 ? thoughtBuffer.slice(punctuationIdx + 1) : "";
        emitThought(chunkToEmit);
      }
    }

    if (thoughtBuffer.trim()) emitThought(thoughtBuffer);

    return {
      content: content.trim(),
      thoughts,
    };
  }

  const completion = await getOpenAILLMClient().chat.completions.create({
    model,
    temperature,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "structured_output",
        strict: true,
        schema,
      },
    },
  });

  return {
    content: completion.choices[0]?.message?.content?.trim() ?? "",
    thoughts: [],
  };
}

export async function embedTexts(input: string[]) {
  if (!input.length) return [];

  const response = await getEmbeddingClient().embeddings.create({
    model: embedModel,
    input,
  });

  return response.data.map((row) => row.embedding);
}

export async function detectQuestionIntent(
  question: string,
  onThought?: ModelThoughtCallback,
) {
  const { content } = await structuredChat(
    verifyModel,
    0,
    "question_intent",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        intent: {
          type: "string",
          enum: ["person_specific", "general"],
        },
        target_person: { type: "string" },
        asks_current_use: { type: "boolean" },
        asks_best: { type: "boolean" },
        asks_aggregate: { type: "boolean" },
      },
      required: [
        "intent",
        "target_person",
        "asks_current_use",
        "asks_best",
        "asks_aggregate",
      ],
    },
    [
      {
        role: "system",
        content: [
          "Classify user question intent for /uses QA.",
          "intent=person_specific if the question is clearly about one person/site/setup.",
          "Otherwise intent=general.",
          "target_person should contain the person/site reference if present, else empty string.",
          "asks_current_use=true when question is about current setup/tools now.",
          "asks_best=true when question asks best/top/recommended.",
          "asks_aggregate=true when question asks most common/popular/frequent/trends across people.",
        ].join(" "),
      },
      {
        role: "user",
        content: `Question: ${question}`,
      },
    ],
    onThought,
  );

  return parseQuestionIntent(content);
}

export async function screenContextForQuestion(
  question: string,
  context: string,
  onThought?: ModelThoughtCallback,
) {
  const { content } = await structuredChat(
    screenModel,
    0,
    "screen_context",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        keep_ids: {
          type: "array",
          items: { type: "integer", minimum: 1 },
        },
      },
      required: ["keep_ids"],
    },
    [
      {
        role: "system",
        content: [
          "You are a retrieval judge for /uses QA.",
          "Select snippet IDs that are highly relevant to the question.",
          "If question asks about a specific person, keep only snippets authored by that person.",
          "Do not keep snippets that merely mention that person in passing.",
          "If the question is about what people use now, keep CURRENT setup evidence.",
          "Reject historical-only mentions such as: previously, used to, before, spent years.",
          "Prefer precision over recall.",
          "Return up to 8 IDs.",
        ].join(" "),
      },
      {
        role: "user",
        content: `Question: ${question}\n\nSnippets:\n${context}`,
      },
    ],
    onThought,
  );

  return parseContextScreenResult(content);
}

export async function extractFactsFromContext(
  question: string,
  context: string,
  onThought?: ModelThoughtCallback,
) {
  const { content } = await structuredChat(
    extractModel,
    0,
    "extract_facts",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        reasoning: { type: "string" },
        facts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              chunk_id: { type: "integer", minimum: 1 },
              person_name: { type: "string" },
              fact: { type: "string" },
              evidence_sentence: { type: "string" },
              is_current: { type: "boolean" },
              relevance: { type: "number" },
            },
            required: [
              "chunk_id",
              "person_name",
              "fact",
              "evidence_sentence",
              "is_current",
              "relevance",
            ],
          },
        },
      },
      required: ["reasoning", "facts"],
    },
    [
      {
        role: "system",
        content: [
          "Extract only directly supported setup facts from snippets.",
          "Never invent facts.",
          "Use the exact snippet IDs.",
          "fact should be short and specific (one equipment/tool statement).",
          "evidence_sentence should be a directly supporting sentence from the snippet.",
          "Do not infer a usage context (for example remote work) unless that same evidence sentence explicitly states it.",
          "Do not blend clues from different sentences into one fact.",
          "Set is_current=false when wording indicates past usage.",
          "Set relevance in [0,1] for relevance to question.",
          "Also output reasoning: 1-2 concise sentences on what evidence was prioritized or excluded.",
          "If unsure, omit the fact.",
        ].join(" "),
      },
      {
        role: "user",
        content: `Question: ${question}\n\nSnippets:\n${context}`,
      },
    ],
    onThought,
  );
  return parseFactsResult(content);
}

export async function answerFromFacts(
  question: string,
  facts: ExtractedFact[],
  onThought?: ModelThoughtCallback,
) {
  if (facts.length === 0) {
    return {
      answer:
        "I couldn't find enough grounded evidence in the indexed snippets to answer confidently.",
      citations: [],
    };
  }

  const { content } = await structuredChat(
    chatModel,
    0,
    "answer_from_facts",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        answer: { type: "string" },
        citations: {
          type: "array",
          items: { type: "integer", minimum: 1 },
        },
      },
      required: ["answer", "citations"],
    },
    [
      {
        role: "system",
        content: [
          "Answer using only provided facts.",
          "Do not merge details from different facts into a new claim unless explicitly supported.",
          "For 'best' questions: if facts do not provide a direct comparative claim for that context, state uncertainty instead of asserting a winner.",
          "Never claim an item is for remote work unless the cited evidence sentence explicitly says so.",
          "For aggregate questions (most common/popular/frequent), compute from repeated facts across different people in evidence.",
          "If aggregate evidence is weak, say it is based on retrieved evidence and uncertain.",
          "If evidence conflicts or is insufficient, say you don't know.",
          "Prefer short Markdown bullets with **bold** key items.",
          "Keep answer concise (about 80-140 words total).",
          "Add inline citations in the answer for every claim using bracket IDs like [3].",
          "Every claim must be grounded by cited fact chunk IDs.",
          "citations array must exactly match the set of bracket IDs used in answer text.",
          "Citations must use only provided chunk IDs.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Question: ${question}`,
          `\nFacts JSON:\n${JSON.stringify(facts)}`,
        ].join("\n"),
      },
    ],
    onThought,
  );

  const parsed = parseModelAnswer(content);
  const allowedCitations = new Set(facts.map((fact) => fact.chunkId));
  return {
    answer: parsed.answer,
    citations: parsed.citations.filter((id) => allowedCitations.has(id)),
  };
}

export async function verifyAnswerFromFacts(
  question: string,
  facts: ExtractedFact[],
  draft: ModelAnswer,
  onThought?: ModelThoughtCallback,
) {
  if (facts.length === 0) return draft;

  const { content } = await structuredChat(
    verifyModel,
    0,
    "verify_answer_from_facts",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        answer: { type: "string" },
        citations: {
          type: "array",
          items: { type: "integer", minimum: 1 },
        },
      },
      required: ["answer", "citations"],
    },
    [
      {
        role: "system",
        content: [
          "You are a strict grounding verifier.",
          "Keep only claims directly supported by provided facts.",
          "Remove any claim that confuses or swaps details across facts.",
          "Remove any claim that assigns a context like remote work without explicit support in cited evidence sentence.",
          "For 'best' questions, remove winner claims without explicit comparative evidence.",
          "If not enough support, answer with uncertainty.",
          "Preserve concise Markdown style.",
          "Ensure each claim in the answer has inline citation markers like [2].",
          "citations array must exactly match bracket IDs used in answer text.",
          "Citations must refer only to provided fact chunk IDs.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Question: ${question}`,
          `\nDraft answer JSON:\n${JSON.stringify(draft)}`,
          `\nFacts JSON:\n${JSON.stringify(facts)}`,
        ].join("\n"),
      },
    ],
    onThought,
  );

  const parsed = parseModelAnswer(content);
  const allowedCitations = new Set(facts.map((fact) => fact.chunkId));

  return {
    answer: parsed.answer,
    citations: parsed.citations.filter((id) => allowedCitations.has(id)),
  };
}
