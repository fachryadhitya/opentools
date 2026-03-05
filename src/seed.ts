import { db, ensureSchema } from "./db";
import { embedTexts } from "./openai-client";
import { chunkText, extractReadableText, normalizeUrl, sha256Hex } from "./text";
import type { DirectoryPerson } from "./types";

const USES_URL = "https://uses.tech/";
const MAX_CONCURRENCY = Number(Bun.env.SEED_CONCURRENCY ?? "4");
const FETCH_TIMEOUT_MS = Number(Bun.env.FETCH_TIMEOUT_MS ?? "15000");
const SEED_LIMIT = Number(Bun.env.SEED_LIMIT ?? "0");

ensureSchema();

const upsertPerson = db.query(`
  INSERT INTO people (
    id, name, description, url, tags_json, country, twitter, emoji, computer, phone, updated_at
  ) VALUES (
    $id, $name, $description, $url, $tags_json, $country, $twitter, $emoji, $computer, $phone, CURRENT_TIMESTAMP
  )
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    url = excluded.url,
    tags_json = excluded.tags_json,
    country = excluded.country,
    twitter = excluded.twitter,
    emoji = excluded.emoji,
    computer = excluded.computer,
    phone = excluded.phone,
    updated_at = CURRENT_TIMESTAMP
`);

const getPageHash = db.query("SELECT content_hash FROM pages WHERE person_id = ?");

const upsertPage = db.query(`
  INSERT INTO pages (
    person_id, page_url, title, content_text, content_hash, fetched_at, fetch_status, error
  ) VALUES (
    $person_id, $page_url, $title, $content_text, $content_hash, $fetched_at, 'ok', NULL
  )
  ON CONFLICT(person_id) DO UPDATE SET
    page_url = excluded.page_url,
    title = excluded.title,
    content_text = excluded.content_text,
    content_hash = excluded.content_hash,
    fetched_at = excluded.fetched_at,
    fetch_status = 'ok',
    error = NULL
`);

const markPageError = db.query(`
  INSERT INTO pages (
    person_id, page_url, title, content_text, content_hash, fetched_at, fetch_status, error
  ) VALUES (
    $person_id, $page_url, '', '', '', $fetched_at, 'error', $error
  )
  ON CONFLICT(person_id) DO UPDATE SET
    page_url = excluded.page_url,
    fetched_at = excluded.fetched_at,
    fetch_status = 'error',
    error = excluded.error
`);

const deleteChunksForPerson = db.query("DELETE FROM chunks WHERE person_id = ?");

const insertChunk = db.query(`
  INSERT INTO chunks (person_id, page_url, chunk_index, chunk_text, embedding_json)
  VALUES (?, ?, ?, ?, ?)
`);

type RemixContext = {
  state?: {
    loaderData?: Record<string, { people?: DirectoryPerson[] } | undefined>;
  };
};

function parseRemixContext(html: string) {
  const match = html.match(/window\.__remixContext\s*=\s*(\{.*?\})\s*;<\/script>/s);
  if (!match) {
    throw new Error("Unable to parse uses.tech remix context");
  }

  return JSON.parse(match[1]) as RemixContext;
}

function getDirectoryPeople(context: RemixContext) {
  const loaderData = context.state?.loaderData;
  if (!loaderData) return [];

  const direct =
    loaderData["routes/index"]?.people ?? loaderData["routes/_index"]?.people;
  if (Array.isArray(direct) && direct.length > 0) {
    return direct;
  }

  for (const routeData of Object.values(loaderData)) {
    if (Array.isArray(routeData?.people) && routeData.people.length > 0) {
      return routeData.people;
    }
  }

  return [];
}

async function fetchDirectoryPeople() {
  const response = await fetch(USES_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "user-agent": "uses-llm-seeder/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`uses.tech returned ${response.status}`);
  }

  const html = await response.text();
  const context = parseRemixContext(html);
  const people = getDirectoryPeople(context);

  if (!people.length) {
    throw new Error("No people found in uses.tech loader data");
  }

  const normalized: DirectoryPerson[] = [];

  for (const person of people) {
    if (!person.id || !person.name || !person.url) continue;

    try {
      normalized.push({
        ...person,
        tags: Array.isArray(person.tags)
          ? person.tags.filter((tag): tag is string => typeof tag === "string")
          : [],
        url: normalizeUrl(person.url, USES_URL),
      });
    } catch {
      continue;
    }
  }

  if (!normalized.length) {
    throw new Error("No valid profile URLs found in uses.tech loader data");
  }

  return normalized;
}

async function fetchPage(url: string) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
    headers: {
      "user-agent": "uses-llm-seeder/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

async function embedAndStoreChunks(person: DirectoryPerson, chunks: string[]) {
  const BATCH_SIZE = 32;

  deleteChunksForPerson.run(person.id);

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const slice = chunks.slice(i, i + BATCH_SIZE);
    const embeddings = await embedTexts(slice);

    slice.forEach((chunk, offset) => {
      insertChunk.run(
        person.id,
        person.url,
        i + offset,
        chunk,
        JSON.stringify(embeddings[offset]),
      );
    });
  }
}

async function processPerson(person: DirectoryPerson) {
  upsertPerson.run({
    $id: person.id,
    $name: person.name,
    $description: person.description ?? "",
    $url: person.url,
    $tags_json: JSON.stringify(person.tags),
    $country: person.country ?? "",
    $twitter: person.twitter ?? "",
    $emoji: person.emoji ?? "",
    $computer: person.computer ?? "",
    $phone: person.phone ?? "",
  });

  try {
    const html = await fetchPage(person.url);
    const { title, content } = extractReadableText(html);

    if (content.length < 350) {
      throw new Error("content too short");
    }

    const hash = await sha256Hex(content);
    const existing = getPageHash.get(person.id) as { content_hash: string } | null;

    if (existing?.content_hash === hash) {
      return { status: "unchanged" as const, chunks: 0 };
    }

    const chunks = chunkText(content);
    if (!chunks.length) {
      throw new Error("no chunks extracted");
    }

    await embedAndStoreChunks(person, chunks);

    upsertPage.run({
      $person_id: person.id,
      $page_url: person.url,
      $title: title,
      $content_text: content,
      $content_hash: hash,
      $fetched_at: new Date().toISOString(),
    });

    return { status: "updated" as const, chunks: chunks.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";

    markPageError.run({
      $person_id: person.id,
      $page_url: person.url,
      $fetched_at: new Date().toISOString(),
      $error: message,
    });

    return { status: "failed" as const, error: message };
  }
}

async function processInBatches<T>(items: T[], worker: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += MAX_CONCURRENCY) {
    const batch = items.slice(i, i + MAX_CONCURRENCY);
    await Promise.all(batch.map((item) => worker(item)));
  }
}

async function main() {
  const allPeople = await fetchDirectoryPeople();
  const people = SEED_LIMIT > 0 ? allPeople.slice(0, SEED_LIMIT) : allPeople;

  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  let chunkCount = 0;

  console.log(`Seeding ${people.length} profiles (source has ${allPeople.length})...`);

  await processInBatches(people, async (person) => {
    const result = await processPerson(person);

    if (result.status === "updated") {
      updated += 1;
      chunkCount += result.chunks;
      console.log(`updated ${person.name} (${result.chunks} chunks)`);
      return;
    }

    if (result.status === "unchanged") {
      unchanged += 1;
      console.log(`unchanged ${person.name}`);
      return;
    }

    failed += 1;
    console.log(`failed ${person.name}: ${result.error}`);
  });

  console.log("\nDone");
  console.log(`updated:   ${updated}`);
  console.log(`unchanged: ${unchanged}`);
  console.log(`failed:    ${failed}`);
  console.log(`chunks:    ${chunkCount}`);
}

await main();
