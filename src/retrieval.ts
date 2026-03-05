import { db } from "./db";
import type { ContextChunk } from "./types";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "most",
  "my",
  "of",
  "on",
  "or",
  "s",
  "t",
  "that",
  "thats",
  "the",
  "their",
  "to",
  "use",
  "used",
  "using",
  "common",
  "developer",
  "developers",
  "dev",
  "whats",
  "what",
  "which",
  "with",
]);

function questionTokens(input: string) {
  return [
    ...new Set(
      (input.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter(
        (token) => !STOPWORDS.has(token),
      ),
    ),
  ].slice(0, 12);
}

function normalizeCompact(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function cosineSimilarity(a: number[], b: number[]) {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function buildFtsQuery(question: string) {
  const tokens = questionTokens(question);

  if (tokens.length === 0) {
    return null;
  }

  return tokens.map((token) => `${token}*`).join(" OR ");
}

function rrfMerge(rankedLists: number[][], k = 60) {
  const scores = new Map<number, number>();

  rankedLists.forEach((list) => {
    list.forEach((id, index) => {
      const current = scores.get(id) ?? 0;
      scores.set(id, current + 1 / (k + index + 1));
    });
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

function scopedVectorRows(personIds?: string[]) {
  if (!personIds || personIds.length === 0) {
    return db
      .query("SELECT id, embedding_json FROM chunks")
      .all() as { id: number; embedding_json: string }[];
  }

  const placeholders = personIds.map(() => "?").join(", ");
  return db
    .query(
      `SELECT id, embedding_json FROM chunks WHERE person_id IN (${placeholders})`,
    )
    .all(...personIds) as { id: number; embedding_json: string }[];
}

function scopedFtsRows(question: string, personIds?: string[]) {
  const ftsQuery = buildFtsQuery(question);
  if (!ftsQuery) return [];

  if (!personIds || personIds.length === 0) {
    return db
      .query(
        `
          SELECT c.id
          FROM chunks_fts
          JOIN chunks c ON c.id = chunks_fts.rowid
          WHERE chunks_fts MATCH ?
          ORDER BY bm25(chunks_fts), c.id ASC
          LIMIT 50
        `,
      )
      .all(ftsQuery) as { id: number }[];
  }

  const placeholders = personIds.map(() => "?").join(", ");
  return db
    .query(
      `
        SELECT c.id
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
          AND c.person_id IN (${placeholders})
        ORDER BY bm25(chunks_fts), c.id ASC
        LIMIT 50
      `,
    )
    .all(ftsQuery, ...personIds) as { id: number }[];
}

function rankVectorRows(
  queryEmbedding: number[],
  vectorRows: { id: number; embedding_json: string }[],
) {
  return vectorRows
    .map((row) => {
      try {
        const embedding = JSON.parse(row.embedding_json) as number[];
        return {
          id: row.id,
          score: cosineSimilarity(queryEmbedding, embedding),
        };
      } catch {
        return { id: row.id, score: -1 };
      }
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 25)
    .map((row) => row.id);
}

function hybridChunkIds(
  question: string,
  queryEmbedding: number[],
  topK = 10,
  personIds?: string[],
) {
  const ftsRows = scopedFtsRows(question, personIds);
  const vectorRows = scopedVectorRows(personIds);
  const rankedVector = rankVectorRows(queryEmbedding, vectorRows);

  const ftsRanked = ftsRows.map((row) => row.id);
  const fused = rrfMerge([ftsRanked, ftsRanked, rankedVector]);
  return fused.slice(0, topK);
}

export function getHybridChunkIds(question: string, queryEmbedding: number[], topK = 10) {
  return hybridChunkIds(question, queryEmbedding, topK);
}

export function findPeopleByNameQuery(nameQuery: string, limit = 2) {
  const people = db
    .query("SELECT id, name, url FROM people")
    .all() as { id: string; name: string; url: string }[];

  const query = nameQuery.trim();
  if (!query) return [];

  const qCompact = normalizeCompact(query);
  const qTokens: string[] = query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  if (!qCompact && qTokens.length === 0) return [];

  const scored = people
    .map((person) => {
      const nameTokens: string[] = person.name.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
      const nameCompact = normalizeCompact(person.name);
      const joinedName = nameTokens.join("");
      const urlCompact = normalizeCompact(person.url);
      let score = 0;

      if (nameCompact && qCompact.includes(nameCompact)) score += 12;
      if (joinedName && qCompact.includes(joinedName)) score += 10;
      if (nameTokens.length > 0 && nameTokens.every((token) => qTokens.includes(token))) {
        score += 8;
      }

      score += nameTokens.filter((token) => qTokens.includes(token)).length * 2;

      if (joinedName && urlCompact.includes(joinedName)) {
        if (qCompact.includes(joinedName)) score += 5;
      }

      return { id: person.id, name: person.name, score };
    })
    .filter((row) => row.score >= 6)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}

export function getHybridChunkIdsForPeople(
  question: string,
  queryEmbedding: number[],
  personIds: string[],
  topK = 10,
) {
  if (personIds.length === 0) return [];
  return hybridChunkIds(question, queryEmbedding, topK, personIds);
}

export function getContextChunks(chunkIds: number[]) {
  if (!chunkIds.length) return [];

  const getChunk = db.query(
    `
      SELECT
        c.id AS chunkId,
        c.person_id AS personId,
        c.chunk_text AS chunkText,
        c.page_url AS pageUrl,
        p.name AS personName,
        p.url AS profileUrl
      FROM chunks c
      JOIN people p ON p.id = c.person_id
      WHERE c.id = ?
    `,
  );

  const chunks: ContextChunk[] = [];
  for (const id of chunkIds) {
    const row = getChunk.get(id) as ContextChunk | null;
    if (row) chunks.push(row);
  }

  return chunks;
}
