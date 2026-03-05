# uses-llm

Simple Bun static site + API for asking LLM questions over indexed `/uses` pages.

## Stack

- Bun server (`Bun.serve`)
- SQLite (`bun:sqlite`) with FTS5
- OpenAI embeddings + chat completion
- Hybrid retrieval (FTS + cosine vector + RRF)
- LLM-driven context screening + answer verification
- Tailwind CSS static UI

## 1) Install

```bash
bun install
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`.
Optional: set `OPENAI_VERIFY_MODEL` / `OPENAI_SCREEN_MODEL` to tune verification and screening stages.

## 2) Build CSS

```bash
bun run build:css
```

## 3) Seed index

```bash
bun run seed
# or smoke test first
bun run seed:smoke
```

Useful seed flags:

```bash
SEED_LIMIT=50 bun run seed
SEED_CONCURRENCY=3 FETCH_TIMEOUT_MS=20000 bun run seed
```

## 4) Run app

```bash
bun run dev
```

Open `http://localhost:3000`.

## API

- `GET /api/health`
- `GET /api/stats`
- `POST /api/ask` body: `{ "question": "..." }`

## Notes

- Seed source is `https://uses.tech/` and parsed from the embedded Remix loader data.
- If a page cannot be fetched, it is stored as `fetch_status=error` in `pages`.

## Deploy on Render

Use a **Web Service** with these commands:

- Build Command: `bun run build:render`
- Start Command: `bun run start:render`

Set env vars in Render:

- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `EMBEDDING_PROVIDER=openai`
- `LLM_PROVIDER=gemini`
- `DB_PATH=/var/data/uses.sqlite`

Important for SQLite persistence:

- Add a **Persistent Disk** in Render and mount it at `/var/data`.

### Seed on Render

After deploy, run a one-off seed command:

```bash
bun run seed:render
```

Where to run it in Render:

1. Open your service.
2. Go to **Shell** (or run a one-off job/command).
3. Execute `bun run seed:render`.

Optional first run smoke seed:

```bash
SEED_LIMIT=20 bun run seed:render
```
