import path from "node:path";
import { db, ensureSchema } from "./db";
import { askUses } from "./rag";

const publicDir = path.join(process.cwd(), "public");
const port = Number(Bun.env.PORT ?? "3000");

ensureSchema();

function contentType(filepath: string) {
  if (filepath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filepath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filepath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filepath.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function validateQuestion(question: string) {
  if (!question || question.length < 3) {
    return "Question must be at least 3 characters.";
  }

  if (question.length > 600) {
    return "Question is too long (max 600 chars).";
  }

  return null;
}

async function serveStatic(pathname: string) {
  const target = pathname === "/" ? "index.html" : pathname.slice(1);
  const filepath = path.join(publicDir, target);
  const file = Bun.file(filepath);

  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(file, {
    headers: {
      "content-type": contentType(filepath),
      "cache-control": "public, max-age=120",
    },
  });
}

Bun.serve({
  port,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, now: new Date().toISOString() });
    }

    if (url.pathname === "/api/stats") {
      const counts = db.query(`
        SELECT
          (SELECT COUNT(*) FROM people) AS people,
          (SELECT COUNT(*) FROM pages WHERE fetch_status = 'ok') AS pages,
          (SELECT COUNT(*) FROM chunks) AS chunks
      `).get() as { people: number; pages: number; chunks: number };

      return Response.json(counts);
    }

    if (url.pathname === "/api/ask" && request.method === "POST") {
      const body = (await request.json()) as { question?: string };
      const question = body.question?.trim() ?? "";
      const validationError = validateQuestion(question);
      if (validationError) {
        return Response.json({ error: validationError }, { status: 400 });
      }

      try {
        const result = await askUses(question);
        return Response.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return Response.json({ error: message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/ask/stream" && request.method === "POST") {
      const body = (await request.json()) as { question?: string };
      const question = body.question?.trim() ?? "";
      const validationError = validateQuestion(question);
      if (validationError) {
        return Response.json({ error: validationError }, { status: 400 });
      }

      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        start(controller) {
          let closed = false;
          const safeClose = () => {
            if (closed) return;
            closed = true;
            try {
              controller.close();
            } catch {}
          };

          const send = (event: string, payload: unknown) => {
            if (closed) return;
            const data = JSON.stringify(payload);
            try {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
            } catch {
              safeClose();
            }
          };

          const heartbeat = setInterval(() => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              safeClose();
            }
          }, 3000);

          void (async () => {
            try {
              send("stage", { message: "Starting..." });
              const result = await askUses(question, (progress) => {
                send(progress.type, { message: progress.message });
              });
              send("result", result);
              send("done", { ok: true });
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unknown error";
              send("error", { error: message });
            } finally {
              clearInterval(heartbeat);
              safeClose();
            }
          })();
        },
        cancel() {},
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    return serveStatic(url.pathname);
  },
});

console.log(`uses-llm server running on http://localhost:${port}`);
