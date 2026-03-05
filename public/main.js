const form = document.getElementById("ask-form");
const questionInput = document.getElementById("question");
const statusEl = document.getElementById("status");
const submitBtn = document.getElementById("submit-btn");
const resultSection = document.getElementById("result");
const answerEl = document.getElementById("answer");
const citationsEl = document.getElementById("citations");
const statPeople = document.getElementById("stat-people");
const statChunks = document.getElementById("stat-chunks");
const themeToggle = document.getElementById("theme-toggle");
const tracePanel = document.getElementById("trace-panel");
const traceList = document.getElementById("trace-list");
let isAsking = false;
let liveReasoningItem = null;

function currentTheme() {
  const theme = document.documentElement.dataset.theme;
  return theme === "dark" ? "dark" : "light";
}

function applyTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  if (!themeToggle) return;
  
  themeToggle.setAttribute("aria-pressed", String(next === "dark"));
  
  if (next === "dark") {
    themeToggle.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>';
  } else {
    themeToggle.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path></svg>';
  }
}

applyTheme(currentTheme());

themeToggle?.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem("theme", next);
  } catch {}
});

async function loadStats() {
  try {
    const response = await fetch("/api/stats");
    if (!response.ok) return;

    const stats = await response.json();
    statPeople.textContent = String(stats.people ?? 0);
    statChunks.textContent = String(stats.chunks ?? 0);
  } catch {
    statPeople.textContent = "-";
    statChunks.textContent = "-";
  }
}

function renderMarkdownish(text) {
  const escapeHtml = (value) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const renderCitationGroup = (idsText) => {
    const ids = [...new Set(
      idsText
        .split(",")
        .map((id) => id.trim())
        .filter((id) => /^\d+$/.test(id)),
    )];

    return ids
      .map(
        (id) =>
          `<a class="citation-ref" href="#citation-${id}" aria-label="Jump to citation ${id}">[${id}]</a>`,
      )
      .join("");
  };

  const renderInline = (line) => {
    let html = escapeHtml(line);
    html = html.replace(/\s+([,.;:!?])/g, "$1");
    html = html.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    );
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/_(?!_)([^_]+)_(?!_)/g, "<em>$1</em>");
    html = html.replace(/\*(?!\*)([^*]+)\*(?!\*)/g, "<em>$1</em>");
    html = html.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, idsText) => renderCitationGroup(idsText));
    return html;
  };

  const lines = text.split("\n");
  const output = [];
  let listType = null;

  const closeList = () => {
    if (!listType) return;
    output.push(`</${listType}>`);
    listType = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }

    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      closeList();
      output.push(`<h3>${renderInline(h3[1])}</h3>`);
      continue;
    }

    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      closeList();
      output.push(`<h2>${renderInline(h2[1])}</h2>`);
      continue;
    }

    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      closeList();
      output.push(`<h1>${renderInline(h1[1])}</h1>`);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        output.push("<ul>");
      }
      output.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }

    const numbered = line.match(/^\d+\.\s+(.+)$/);
    if (numbered) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        output.push("<ol>");
      }
      output.push(`<li>${renderInline(numbered[1])}</li>`);
      continue;
    }

    closeList();
    output.push(`<p>${renderInline(line)}</p>`);
  }

  closeList();
  return output.join("");
}

function renderCitations(citations) {
  citationsEl.innerHTML = "";

  citations.forEach((citation) => {
    const item = document.createElement("li");
    item.className = "citation-item";
    item.id = `citation-${citation.id}`;

    item.innerHTML = `
      <div class="flex items-center gap-2 mb-1">
        <span class="text-xs text-muted">[${citation.id}]</span>
        <span class="text-xs font-medium text-text">${citation.person}</span>
      </div>
      <a class="text-sm truncate block w-full text-muted hover:text-text transition-colors" href="${citation.pageUrl}" target="_blank" rel="noreferrer">${citation.pageUrl}</a>
      <p class="mt-2 text-sm leading-relaxed">${citation.excerpt}</p>
    `;

    citationsEl.appendChild(item);
  });
}

function resetTrace() {
  if (!traceList || !tracePanel) return;
  traceList.innerHTML = "";
  tracePanel.classList.add("hidden");
  liveReasoningItem = null;
}

function renderInlineMarkdown(text) {
  const escapeHtml = (value) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  let html = escapeHtml(text);
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/_(?!_)([^_]+)_(?!_)/g, "<em>$1</em>");
  html = html.replace(/\*(?!\*)([^*]+)\*(?!\*)/g, "<em>$1</em>");
  return html;
}

function normalizeReasoningMessage(message) {
  return message.replace(/^\[[^\]]*Reasoning\]\s*/i, "").trim();
}

function upsertLiveReasoning(message) {
  if (!traceList || !tracePanel) return;
  const cleanMessage = normalizeReasoningMessage(message);
  if (!cleanMessage) return;

  if (!liveReasoningItem) {
    liveReasoningItem = document.createElement("li");
    liveReasoningItem.className = "trace-item";
    traceList.appendChild(liveReasoningItem);
  }

  liveReasoningItem.innerHTML = renderInlineMarkdown(cleanMessage);
  tracePanel.classList.remove("hidden");
}

function parseSseBlock(block) {
  const lines = block.replace(/\r/g, "").split("\n");
  let event = "message";
  let data = "";

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      data += line.slice(5).trim();
    }
  }

  if (!data) return null;

  try {
    return { event, payload: JSON.parse(data) };
  } catch {
    return { event, payload: { raw: data } };
  }
}

async function askUsesStream(question, onEvent) {
  const response = await fetch("/api/ask/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Failed to ask question");
  }

  if (!response.body) {
    throw new Error("Streaming is not available.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex === -1) break;

      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const parsed = parseSseBlock(block);
      if (!parsed) continue;
      onEvent(parsed.event, parsed.payload);
    }
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isAsking) return;

  const question = questionInput.value.trim();
  if (!question) return;

  isAsking = true;
  submitBtn.disabled = true;
  questionInput.disabled = true;
  statusEl.textContent = "Thinking...";
  answerEl.innerHTML = "";
  citationsEl.innerHTML = "";
  resultSection.classList.add("hidden");
  resetTrace();

  try {
    let finalPayload = null;

    await askUsesStream(question, (eventType, payload) => {
      if (eventType === "stage") {
        statusEl.textContent = payload.message || "Thinking...";
        return;
      }

      if (eventType === "trace") {
        upsertLiveReasoning(payload.message || "Tracing...");
        return;
      }

      if (eventType === "result") {
        finalPayload = payload;
        return;
      }

      if (eventType === "error") {
        throw new Error(payload.error || "Request failed");
      }
    });

    if (!finalPayload) {
      throw new Error("No result from stream.");
    }

    answerEl.innerHTML = renderMarkdownish(finalPayload.answer || "No answer.");
    renderCitations(finalPayload.citations || []);
    statusEl.textContent = `Done. ${finalPayload.citations?.length || 0} citations used.`;
    resultSection.classList.remove("hidden");
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : "Request failed";
  } finally {
    isAsking = false;
    submitBtn.disabled = false;
    questionInput.disabled = false;
  }
});

questionInput.addEventListener("keydown", (event) => {
  if (isAsking) {
    event.preventDefault();
    return;
  }
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  form.requestSubmit();
});

loadStats();
