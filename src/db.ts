import { Database } from "bun:sqlite";

const DB_PATH = Bun.env.DB_PATH ?? "./data/uses.sqlite";

export const db = new Database(DB_PATH, { create: true });

db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA foreign_keys = ON;");

export function ensureSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      url TEXT NOT NULL UNIQUE,
      tags_json TEXT NOT NULL DEFAULT '[]',
      country TEXT,
      twitter TEXT,
      emoji TEXT,
      computer TEXT,
      phone TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pages (
      person_id TEXT PRIMARY KEY,
      page_url TEXT NOT NULL,
      title TEXT,
      content_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      fetch_status TEXT NOT NULL,
      error TEXT,
      FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id TEXT NOT NULL,
      page_url TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_person_id ON chunks(person_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_text,
      content='chunks',
      content_rowid='id',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, chunk_text) VALUES (new.id, new.chunk_text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text)
      VALUES ('delete', old.id, old.chunk_text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text)
      VALUES ('delete', old.id, old.chunk_text);
      INSERT INTO chunks_fts(rowid, chunk_text) VALUES (new.id, new.chunk_text);
    END;
  `);
}
