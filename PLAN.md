# uses-llm Plan

Date: March 5, 2026

## Goal

Build a simple Bun app (static Tailwind UI + server API) that can answer natural-language questions over `/uses` pages indexed from `uses.tech`.

## Target Architecture (V2)

1. `seed pipeline`

- Fetch full directory from `https://uses.tech/` embedded Remix loader data.
- Crawl each user `/uses` URL.
- Extract readable page text.
- Chunk content.
- Generate embeddings with OpenAI (`text-embedding-3-small`).
- Store into SQLite.

2. `storage`

- SQLite tables: `people`, `pages`, `chunks`.
- FTS5 virtual table over chunk text for keyword search.
- Embeddings stored per chunk (JSON) for cosine vector search.

3. `retrieval + answer`

- Query embedding from user question.
- Run FTS search + vector similarity search.
- Fuse rankings with RRF.
- Send top context chunks to chat model (`gpt-4.1-mini`).
- Return answer + citations.

4. `frontend`

- Static HTML + Tailwind CSS + plain JS.
- One textarea + ask button.
- Render answer and clickable citations.

## Execution Steps

1. Initialize project in correct folder.
2. Add dependencies (`openai`, `cheerio`, `tailwindcss`, `@tailwindcss/cli`).
3. Implement DB schema and setup.
4. Implement seed script with crawl + embedding.
5. Implement hybrid retrieval and RRF.
6. Implement `/api/ask`, `/api/stats`, `/api/health`.
7. Build Tailwind static UI.
8. Smoke test with `SEED_LIMIT=20` first.
9. Full seed run.

## File Plan

- `package.json`
- `.env.example`
- `README.md`
- `src/db.ts`
- `src/text.ts`
- `src/openai-client.ts`
- `src/seed.ts`
- `src/retrieval.ts`
- `src/rag.ts`
- `src/server.ts`
- `src/styles/tailwind.css`
- `public/index.html`
- `public/main.js`

## Env Vars

- `OPENAI_API_KEY` (required)
- `OPENAI_EMBED_MODEL=text-embedding-3-small`
- `OPENAI_CHAT_MODEL=gpt-4.1-mini`
- `PORT=3000`
- Optional: `SEED_LIMIT`, `SEED_CONCURRENCY`, `FETCH_TIMEOUT_MS`

## Runbook

```bash
bun install
cp .env.example .env
# set OPENAI_API_KEY
bun run build:css
SEED_LIMIT=20 bun run seed
bun run dev (assume its already run, no need to run again)
```

Then open `http://localhost:3000` and test ask flow.

## Validation Checklist

- `GET /api/stats` shows non-zero `people/chunks` after seed.
- Ask endpoint returns answer + citations.
- Citations link to source `/uses` pages.
- Re-running seed skips unchanged pages via hash check.

## Risks

- Some `/uses` pages block bots or are too noisy.
- FTS query syntax can fail on special characters; sanitize input.
- JS cosine over all chunks is fine for ~1k profiles but may need vector index later.

## Later Improvements

1. Add reranker step for higher answer precision.
2. Add scheduled incremental crawl.
3. Add retry/backoff and domain-level throttling.
4. Add admin page for failed crawls and reindex actions.
