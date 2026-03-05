import { load } from "cheerio";

function clean(text: string) {
  return text.replace(/\u0000/g, " ").replace(/\s+/g, " ").trim();
}

function removeBoilerplateText(text: string) {
  return clean(
    text
      .replace(/\bskip to (main )?content\b/gi, " ")
      .replace(/\bskip to navigation\b/gi, " ")
      .replace(/\bskip to footer\b/gi, " "),
  );
}

export function normalizeUrl(raw: string, base?: string) {
  const parsed = base ? new URL(raw.trim(), base) : new URL(raw.trim());
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  parsed.hash = "";
  return parsed.toString();
}

export function extractReadableText(html: string) {
  const $ = load(html);

  $(
    [
      "script",
      "style",
      "noscript",
      "svg",
      "iframe",
      "nav",
      "footer",
      "header",
      "[hidden]",
      "[aria-hidden='true']",
      ".sr-only",
      ".visually-hidden",
      ".screen-reader-text",
      "[style*='display:none']",
      "[style*='display: none']",
      "[style*='visibility:hidden']",
      "[style*='visibility: hidden']",
    ].join(", "),
  ).remove();

  $("a").each((_, el) => {
    const text = clean($(el).text()).toLowerCase();
    if (/^skip to (main )?content$/.test(text) || /^skip to navigation$/.test(text)) {
      $(el).remove();
    }
  });

  const title = clean($("title").first().text());
  const candidates = [
    removeBoilerplateText($("main").text()),
    removeBoilerplateText($("article").text()),
    removeBoilerplateText($("body").text()),
  ].filter(Boolean);

  const content = candidates.sort((a, b) => b.length - a.length)[0] ?? "";
  return { title, content };
}

export function chunkText(input: string, maxChars = 1200) {
  const text = clean(input);
  if (!text) return [];

  const paragraphs = text
    .split(/(?<=\.)\s{2,}|\n+/)
    .map((p) => clean(p))
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      const sentences = para.split(/(?<=[.!?])\s+/).map((s) => clean(s)).filter(Boolean);
      for (const sentence of sentences) {
        if (!sentence) continue;
        if ((current + " " + sentence).trim().length > maxChars) {
          if (current) chunks.push(current);
          current = sentence;
        } else {
          current = (current ? `${current} ` : "") + sentence;
        }
      }
      continue;
    }

    if ((current + " " + para).trim().length > maxChars) {
      if (current) chunks.push(current);
      current = para;
      continue;
    }

    current = (current ? `${current} ` : "") + para;
  }

  if (current) chunks.push(current);
  return chunks.filter((chunk) => chunk.length > 120);
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
