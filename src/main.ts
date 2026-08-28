import {
  App,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  requestUrl
} from "obsidian";

type SourceType = "conversation" | "file" | "article" | "clipboard" | "selection";
type NoteLanguage = "auto" | "zh" | "en";

interface AMemSettings {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  embeddingModel: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  notesFolder: string;
  tagPrefix: string;
  tagTaxonomy: string;
  categoryTaxonomy: string;
  language: NoteLanguage;
  autoLink: boolean;
  updateNeighbors: boolean;
  createMoc: boolean;
  useControlledTags: boolean;
  maxNotesPerIngest: number;
  maxChunkCharacters: number;
  chunkOverlapCharacters: number;
  maxNeighbors: number;
  minSimilarity: number;
  chatRetrievalCount: number;
}

const DEFAULT_SETTINGS: AMemSettings = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  chatModel: "gpt-4o-mini",
  embeddingModel: "text-embedding-3-small",
  embeddingBaseUrl: "",
  embeddingApiKey: "",
  notesFolder: "A-mem",
  tagPrefix: "amem",
  tagTaxonomy: "research, project, idea, decision, concept, person, question, task, reference, conversation, article, file, insight, how-to",
  categoryTaxonomy: "Research, Project, Idea, Decision, Concept, Person, Question, Task, Reference, Conversation, Article, File, General",
  language: "auto",
  autoLink: true,
  updateNeighbors: true,
  createMoc: true,
  useControlledTags: true,
  maxNotesPerIngest: 12,
  maxChunkCharacters: 12000,
  chunkOverlapCharacters: 800,
  maxNeighbors: 5,
  minSimilarity: 0.34,
  chatRetrievalCount: 6
};

interface SourceDocument {
  type: SourceType;
  title: string;
  text: string;
  sourcePath?: string;
  sourceUrl?: string;
  sourceAnchor?: string;
  capturedAt: string;
}

interface GeneratedNote {
  title: string;
  content: string;
  keywords: string[];
  context: string;
  tags: string[];
  category: string;
  noteType: string;
  importance: number;
  sourceAnchor?: string;
}

interface IndexEntry {
  id: string;
  path: string;
  title: string;
  context: string;
  keywords: string[];
  tags: string[];
  category: string;
  noteType: string;
  createdAt: string;
  links: string[];
  contentPreview: string;
  embedding?: number[];
}

interface AMemIndex {
  version: 1;
  updatedAt: string;
  notes: IndexEntry[];
}

interface Neighbor {
  entry: IndexEntry;
  score: number;
}

interface NeighborUpdate {
  context?: string;
  tags?: string[];
}

interface EvolutionDecision {
  shouldEvolve: boolean;
  actions: string[];
  suggestedConnections: string[];
  tagsToUpdate: string[];
  neighborUpdates: Map<string, NeighborUpdate>;
}

interface IngestResult {
  created: IndexEntry[];
  chunksProcessed: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatAnswer {
  answer: string;
  sources: Neighbor[];
}

const CHAT_VIEW_TYPE = "auto-zettelkasten-chat";

export default class AMemNotesPlugin extends Plugin {
  settings!: AMemSettings;
  private service!: AMemService;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.service = new AMemService(this.app, this);

    this.addSettingTab(new AMemSettingTab(this.app, this));
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new AMemChatView(leaf, this));

    this.addRibbonIcon("brain", "Create A-mem notes from clipboard", () => {
      void this.ingestClipboard();
    });
    this.addRibbonIcon("message-circle", "Ask Auto-Zettelkasten notes", () => {
      void this.activateChat();
    });

    this.addCommand({
      id: "ingest-selection",
      name: "Ingest selected text as A-mem notes",
      editorCallback: (editor, view) => {
        const text = editor.getSelection().trim();
        if (!text) {
          new Notice("A-mem：请先选中要处理的文本。");
          return;
        }
        void this.runIngest({
          type: "selection",
          title: `Selection from ${view.file?.basename ?? "note"}`,
          text,
          sourcePath: view.file?.path,
          sourceAnchor: "selected text",
          capturedAt: new Date().toISOString()
        });
      }
    });

    this.addCommand({
      id: "ingest-current-file",
      name: "Ingest current file as A-mem notes",
      callback: () => void this.ingestActiveFile()
    });

    this.addCommand({
      id: "ingest-clipboard",
      name: "Ingest clipboard text as A-mem notes",
      callback: () => void this.ingestClipboard()
    });

    this.addCommand({
      id: "ingest-article-url",
      name: "Ingest web article URL as A-mem notes",
      callback: () => {
        new UrlPromptModal(this.app, (url) => void this.ingestArticle(url)).open();
      }
    });

    this.addCommand({
      id: "open-notes-chat",
      name: "Open notes chatbot",
      callback: () => void this.activateChat()
    });

    this.addCommand({
      id: "rebuild-moc",
      name: "Rebuild A-mem MOC",
      callback: () => void this.rebuildMoc()
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) {
          return;
        }
        menu.addItem((item) => {
          item
            .setTitle("Create A-mem notes from this file")
            .setIcon("brain")
            .onClick(() => void this.ingestVaultFile(file));
        });
      })
    );
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getMemoryService(): AMemService {
    return this.service;
  }

  async activateChat(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  private async ingestActiveFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("A-mem：没有可处理的当前文件。");
      return;
    }
    await this.ingestVaultFile(file);
  }

  private async ingestVaultFile(file: TFile): Promise<void> {
    const supported = new Set(["md", "txt", "html", "htm", "json", "csv"]);
    if (!supported.has(file.extension.toLowerCase())) {
      new Notice("A-mem：当前版本仅直接处理 Markdown、文本、HTML、JSON 和 CSV 文件。PDF 请先导入为文本或 Markdown。");
      return;
    }

    try {
      let text = await this.app.vault.read(file);
      let title = file.basename;
      if (file.extension.toLowerCase() === "html" || file.extension.toLowerCase() === "htm") {
        const article = extractArticleFromHtml(text, "");
        text = article.text;
        title = article.title || title;
      }
      await this.runIngest({
        type: "file",
        title,
        text,
        sourcePath: file.path,
        capturedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error("A-mem file ingestion failed", error);
      new Notice(`A-mem：无法读取文件：${errorMessage(error)}`);
    }
  }

  private async ingestClipboard(): Promise<void> {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        new Notice("A-mem：剪贴板中没有文本。");
        return;
      }
      await this.runIngest({
        type: "clipboard",
        title: "Clipboard capture",
        text,
        capturedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error("A-mem clipboard ingestion failed", error);
      new Notice("A-mem：无法访问剪贴板。请在 Obsidian 中允许剪贴板访问，或把文本粘贴到笔记后使用“处理选中文本”。");
    }
  }

  private async ingestArticle(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) {
      new Notice("A-mem：请输入以 http:// 或 https:// 开头的 URL。");
      return;
    }

    try {
      new Notice("A-mem：正在获取文章正文…", 4000);
      const response: any = await requestUrl({ url, method: "GET" });
      const article = extractArticleFromHtml(String(response.text ?? ""), url);
      if (!article.text) {
        throw new Error("未能从页面提取足够的正文文本");
      }
      await this.runIngest({
        type: "article",
        title: article.title || new URL(url).hostname,
        text: article.text,
        sourceUrl: url,
        sourceAnchor: article.publishedAt ? `published: ${article.publishedAt}` : undefined,
        capturedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error("A-mem article ingestion failed", error);
      new Notice(`A-mem：获取文章失败：${errorMessage(error)}`);
    }
  }

  private async rebuildMoc(): Promise<void> {
    try {
      await this.service.rebuildMoc();
      new Notice("A-mem：MOC 已更新。");
    } catch (error) {
      console.error("A-mem MOC rebuild failed", error);
      new Notice(`A-mem：无法更新 MOC：${errorMessage(error)}`);
    }
  }

  private async runIngest(source: SourceDocument): Promise<void> {
    try {
      new Notice("A-mem：正在生成 atomic notes、标签与关联…", 5000);
      const result = await this.service.ingest(source);
      new Notice(`A-mem：已创建 ${result.created.length} 条 note（处理了 ${result.chunksProcessed} 个文本分块）。`);
    } catch (error) {
      console.error("A-mem ingestion failed", error);
      new Notice(`A-mem：生成失败：${errorMessage(error)}`);
    }
  }
}

class AMemService {
  private readonly maxChunksPerIngest = 12;

  constructor(
    private readonly app: App,
    private readonly plugin: AMemNotesPlugin
  ) {}

  private get settings(): AMemSettings {
    return this.plugin.settings;
  }

  async ingest(source: SourceDocument): Promise<IngestResult> {
    this.assertConfigured();
    await this.ensureFolder(this.settings.notesFolder);

    const sourceText = cleanInput(source.text);
    if (sourceText.length < 20) {
      throw new Error("输入文本过短，至少需要一两句话。");
    }

    let chunks = splitIntoChunks(
      sourceText,
      this.settings.maxChunkCharacters,
      this.settings.chunkOverlapCharacters
    );
    if (chunks.length > this.maxChunksPerIngest) {
      chunks = chunks.slice(0, this.maxChunksPerIngest);
      new Notice(`A-mem：内容较长，本次先处理前 ${this.maxChunksPerIngest} 个分块。可增大“每块最大字符数”后重试。`, 7000);
    }

    const controlledTags = await this.collectControlledTags();
    const perChunkLimit = Math.max(1, Math.ceil(this.settings.maxNotesPerIngest / chunks.length));
    const generated: GeneratedNote[] = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const notes = await this.generateNotes({
        source,
        chunk: chunks[index],
        chunkIndex: index,
        chunkCount: chunks.length,
        controlledTags,
        maximumNotes: perChunkLimit
      });
      generated.push(...notes);
    }

    const notes = deduplicateNotes(generated)
      .sort((left, right) => right.importance - left.importance)
      .slice(0, this.settings.maxNotesPerIngest);

    if (!notes.length) {
      throw new Error("模型没有返回有效的 note。请确认模型支持 JSON 输出，或重试。 ");
    }

    const memoryIndex = await this.loadIndex();
    const embeddings = new Map<GeneratedNote, number[]>();
    if (this.settings.autoLink && this.settings.embeddingModel.trim()) {
      try {
        await this.backfillIndexEmbeddings(memoryIndex);
        const vectors = await this.embedMany(notes.map((note) => this.embeddingTextForGenerated(note)));
        notes.forEach((note, index) => {
          if (vectors[index]) {
            embeddings.set(note, vectors[index]);
          }
        });
      } catch (error) {
        console.warn("A-mem embeddings unavailable; using keyword similarity only", error);
        new Notice("A-mem：embedding 不可用，将使用关键词相似度；仍会生成标签和 notes。", 6000);
      }
    }

    const created: IndexEntry[] = [];
    for (const note of notes) {
      const id = createMemoryId();
      const embedding = embeddings.get(note);
      const neighbors = this.settings.autoLink
        ? rankNeighbors(note, embedding, memoryIndex.notes, this.settings.maxNeighbors, this.settings.minSimilarity)
        : [];

      let decision = emptyEvolutionDecision();
      if (neighbors.length) {
        try {
          decision = await this.evolveNote(note, neighbors);
        } catch (error) {
          console.warn("A-mem evolution decision failed", error);
          new Notice("A-mem：本条 note 的链接演化失败，已保留 note 与自动标签。", 5000);
        }
      }

      if (decision.tagsToUpdate.length) {
        note.tags = uniqueStrings([...note.tags, ...decision.tagsToUpdate]);
      }

      const neighborById = new Map(neighbors.map((neighbor) => [neighbor.entry.id, neighbor.entry]));
      const linkedEntries = decision.suggestedConnections
        .map((neighborId) => neighborById.get(neighborId))
        .filter((entry): entry is IndexEntry => Boolean(entry));

      const timestamp = amemTimestamp();
      const tags = this.normalizeTags(note.tags, note.category, source.type);
      const path = await this.uniqueNotePath(note.title, timestamp, id);
      const entry: IndexEntry = {
        id,
        path,
        title: note.title,
        context: note.context,
        keywords: uniqueStrings(note.keywords).slice(0, 12),
        tags,
        category: note.category,
        noteType: note.noteType,
        createdAt: new Date().toISOString(),
        links: linkedEntries.map((neighbor) => neighbor.id),
        contentPreview: truncate(note.content, 1000),
        embedding
      };

      const markdown = this.renderNote(entry, note, source, timestamp, linkedEntries);
      await this.app.vault.create(path, markdown);
      memoryIndex.notes.push(entry);
      created.push(entry);

      for (const neighbor of linkedEntries) {
        const update = decision.neighborUpdates.get(neighbor.id);
        await this.updateNeighbor(
          neighbor,
          entry,
          update && this.settings.updateNeighbors ? update : undefined,
          timestamp
        );
      }
    }

    memoryIndex.updatedAt = new Date().toISOString();
    await this.saveIndex(memoryIndex);
    if (this.settings.createMoc) {
      await this.writeMoc(memoryIndex);
    }

    return { created, chunksProcessed: chunks.length };
  }

  async answerQuestion(question: string, history: ChatMessage[]): Promise<ChatAnswer> {
    this.assertConfigured();
    const index = await this.loadIndex();
    if (!index.notes.length) {
      throw new Error("还没有 A-mem notes。请先导入对话、文件或文章。");
    }

    let questionVector: number[] | undefined;
    try {
      await this.backfillIndexEmbeddings(index);
      questionVector = (await this.embedMany([truncate(question, 6000)]))[0];
    } catch (error) {
      console.warn("A-mem chat embedding unavailable; using lexical search", error);
    }

    const query: GeneratedNote = {
      title: question,
      content: question,
      keywords: tokenize(question).slice(0, 12),
      context: question,
      tags: [],
      category: "Question",
      noteType: "question",
      importance: 3
    };
    const sources = rankNeighbors(query, questionVector, index.notes, this.settings.chatRetrievalCount, this.settings.minSimilarity);
    if (!sources.length) {
      throw new Error("没有找到足够相关的 A-mem notes。请换一种问法或先导入相关资料。");
    }

    const context = await Promise.all(sources.map(async ({ entry, score }, position) => {
      const file = this.app.vault.getAbstractFileByPath(entry.path);
      const raw = file instanceof TFile ? await this.app.vault.read(file) : entry.contentPreview;
      return `[${position + 1}] id=${entry.id}\ntitle=${entry.title}\npath=${entry.path}\nsimilarity=${score.toFixed(3)}\n${truncate(stripFrontmatter(raw), 3500)}`;
    }));
    const prior = history.slice(-6).map((message) => `${message.role}: ${message.content}`).join("\n");
    const answer = await this.chatText(
      "You answer questions over an A-mem note collection. Use only the supplied notes. State uncertainty or missing evidence. Answer in the user's language. Cite factual claims with [n] and never invent note titles, paths, or sources.",
      `Question:\n${question}\n\nConversation history:\n${prior || "(none)"}\n\nRetrieved A-mem notes:\n${context.join("\n\n---\n\n")}`
    );
    await this.touchRetrievedNotes(sources);
    index.updatedAt = new Date().toISOString();
    await this.saveIndex(index);
    return { answer, sources };
  }

  async rebuildMoc(): Promise<void> {
    await this.ensureFolder(this.settings.notesFolder);
    const index = await this.loadIndex();
    await this.writeMoc(index);
  }

  private assertConfigured(): void {
    if (!this.settings.apiKey.trim()) {
      throw new Error("请先在 Settings → A-mem Notes 中填写 API key。");
    }
    if (!this.settings.baseUrl.trim()) {
      throw new Error("请先在 Settings → A-mem Notes 中填写 OpenAI-compatible base URL。");
    }
    if (!this.settings.chatModel.trim()) {
      throw new Error("请先设置聊天模型名称。");
    }
  }

  private async generateNotes(args: {
    source: SourceDocument;
    chunk: string;
    chunkIndex: number;
    chunkCount: number;
    controlledTags: string[];
    maximumNotes: number;
  }): Promise<GeneratedNote[]> {
    const languageInstruction = this.settings.language === "auto"
      ? "Use the dominant language of the source."
      : this.settings.language === "zh"
        ? "Write titles, content, context, keywords, and tags in Chinese unless a technical term is normally English."
        : "Write titles, content, context, keywords, and tags in English.";

    const taxonomy = args.controlledTags.length
      ? args.controlledTags.join(", ")
      : "(No controlled list; make concise, reusable tags.)";

    const prompt = `You are an A-mem note constructor. Convert one source chunk into durable, atomic Zettelkasten-style memory notes.

A-mem principles to apply:
- A note contains one independently useful claim, decision, fact, procedure, question, or concept.
- Make each note self-contained. Keep uncertainty and attribution; never invent facts.
- Extract specific keywords, a one-sentence context, categorical tags, and a category.
- Tags must support later retrieval. Include domain, format/source, and note-type ideas when useful.
- Do not use speaker names or timestamps as keywords unless they are semantically essential.
- Do not write a generic summary note if a set of smaller notes is more useful.
- ${languageInstruction}

Return JSON only, with exactly this shape:
{
  "notes": [
    {
      "title": "short specific title",
      "content": "2-8 concise sentences in Markdown, self-contained",
      "keywords": ["specific keyword", "another keyword", "third keyword"],
      "context": "one sentence: domain/topic, key point, and purpose or audience",
      "tags": ["3-8 concise categorical tags"],
      "category": "one category",
      "note_type": "concept|fact|decision|procedure|question|task|quote|insight",
      "importance": 1,
      "source_anchor": "brief quote, heading, or turn reference from the source"
    }
  ]
}

Use at most ${args.maximumNotes} notes for this chunk. Importance is an integer from 1 to 5. Prefer this controlled tag vocabulary when it fits; add a precise new tag only when necessary:
${taxonomy}

Source metadata:
- source type: ${args.source.type}
- source title: ${args.source.title}
- chunk: ${args.chunkIndex + 1}/${args.chunkCount}
${args.source.sourceUrl ? `- source URL: ${args.source.sourceUrl}` : ""}
${args.source.sourcePath ? `- source file: ${args.source.sourcePath}` : ""}

Source chunk:
---
${args.chunk}
---`;

    const payload = await this.chatJson(prompt);
    const rawNotes = isRecord(payload) && Array.isArray(payload.notes) ? payload.notes : [];
    return rawNotes
      .map((raw) => coerceGeneratedNote(raw, args.source.title))
      .filter((note): note is GeneratedNote => Boolean(note));
  }

  private async evolveNote(note: GeneratedNote, neighbors: Neighbor[]): Promise<EvolutionDecision> {
    const neighborDetails = neighbors.map((neighbor) => ({
      id: neighbor.entry.id,
      title: neighbor.entry.title,
      similarity: Number(neighbor.score.toFixed(3)),
      context: neighbor.entry.context,
      keywords: neighbor.entry.keywords,
      tags: neighbor.entry.tags,
      content_preview: truncate(neighbor.entry.contentPreview, 600)
    }));

    const prompt = `You are the A-mem memory evolution agent. Analyze one new memory note against its nearest existing notes. Decide whether meaningful memory evolution is warranted.

New memory note:
${JSON.stringify({
  title: note.title,
  content: note.content,
  context: note.context,
  keywords: note.keywords,
  tags: note.tags,
  category: note.category
}, null, 2)}

Nearest neighbor memories:
${JSON.stringify(neighborDetails, null, 2)}

Use A-mem operations:
- "strengthen": connect the new note only to neighbors that have a clear, useful semantic relation; do not link merely because of broad topical overlap.
- "update_neighbor": only refine a neighbor's context or tags when the new note genuinely adds a better taxonomy. Preserve useful existing metadata.

Return JSON only with this exact shape:
{
  "should_evolve": true,
  "actions": ["strengthen", "update_neighbor"],
  "suggested_connections": ["neighbor id"],
  "tags_to_update": ["optional better tags for the new note"],
  "new_context_neighborhood": [{"id": "neighbor id", "context": "replacement or refined context"}],
  "new_tags_neighborhood": [{"id": "neighbor id", "tags": ["replacement or additional tags"]}]
}

Requirements:
- Every id must be one of the supplied neighbor ids.
- If no evolution is useful, set should_evolve false and all arrays empty.
- Never merge or delete notes. Return concise metadata only.`;

    const payload = await this.chatJson(prompt);
    return coerceEvolutionDecision(payload, new Set(neighbors.map((neighbor) => neighbor.entry.id)));
  }

  private async chatText(system: string, prompt: string): Promise<string> {
    const response = await this.postJson("chat/completions", {
      model: this.settings.chatModel.trim(),
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }]
    }) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("聊天模型没有返回回答内容。");
    }
    return content.trim();
  }

  private async touchRetrievedNotes(sources: Neighbor[]): Promise<void> {
    await Promise.all(sources.map(async ({ entry }) => {
      const file = this.app.vault.getAbstractFileByPath(entry.path);
      if (!(file instanceof TFile)) return;
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        const data = frontmatter as Record<string, unknown>;
        data.retrieval_count = Math.max(0, Number(data.retrieval_count ?? 0) || 0) + 1;
        data.last_accessed = new Date().toISOString();
      });
    }));
  }

  private async chatJson(prompt: string): Promise<unknown> {
    const basePayload = {
      model: this.settings.chatModel.trim(),
      // GPT-5 reasoning variants accept only the provider default temperature.
      // Omitting this field also keeps the request compatible with strict OpenAI-style APIs.
      messages: [
        {
          role: "system",
          content: "You are a precise memory-organizing assistant. Return valid JSON and no Markdown fence."
        },
        { role: "user", content: prompt }
      ]
    };

    let response: unknown;
    try {
      response = await this.postJson("chat/completions", {
        ...basePayload,
        response_format: { type: "json_object" }
      });
    } catch (error) {
      const message = errorMessage(error);
      if (!/response_format|json_object|unsupported|status 400|status 422/i.test(message)) {
        throw error;
      }
      response = await this.postJson("chat/completions", basePayload);
    }

    const completion = response as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = completion.choices?.[0]?.message?.content;
    if (typeof content === "object" && content !== null) {
      return content;
    }
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("聊天模型没有返回可解析的内容。");
    }
    return parseModelJson(content);
  }

  private async embedMany(inputs: string[]): Promise<number[][]> {
    if (!inputs.length) {
      return [];
    }
    const batches = chunkArray(inputs, 64);
    const vectors: number[][] = [];
    for (const batch of batches) {
      const response = await this.postJson("embeddings", {
        model: this.settings.embeddingModel.trim(),
        input: batch
      }, this.embeddingConfiguration()) as { data?: Array<{ embedding?: number[]; index?: number }> };
      const data = Array.isArray(response.data) ? [...response.data] : [];
      data.sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
      const batchVectors = data.map((item) => item.embedding).filter((item): item is number[] => Array.isArray(item));
      if (batchVectors.length !== batch.length) {
        throw new Error("embedding 接口返回的向量数量不完整。");
      }
      vectors.push(...batchVectors);
    }
    return vectors;
  }

  private async postJson(
    endpoint: string,
    body: Record<string, unknown>,
    credentials?: { baseUrl: string; apiKey: string }
  ): Promise<unknown> {
    const baseUrl = credentials?.baseUrl || this.settings.baseUrl.trim();
    const apiKey = credentials?.apiKey || this.settings.apiKey.trim();
    const response: any = await requestUrl({
      url: this.apiUrl(endpoint, baseUrl),
      method: "POST",
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      // Keep the provider's JSON error body so the Notice can explain a 400 precisely.
      throw: false
    });

    if (Number(response.status) >= 400) {
      throw new Error(`API status ${response.status}: ${truncate(String(response.text ?? ""), 500)}`);
    }
    if (response.json !== undefined && response.json !== null) {
      return response.json;
    }
    return JSON.parse(String(response.text ?? ""));
  }

  private apiUrl(endpoint: string, baseUrl = this.settings.baseUrl): string {
    return `${baseUrl.trim().replace(/\/+$/, "")}/${endpoint}`;
  }

  private embeddingConfiguration(): { baseUrl: string; apiKey: string } {
    return {
      baseUrl: this.settings.embeddingBaseUrl.trim() || this.settings.baseUrl.trim(),
      apiKey: this.settings.embeddingApiKey.trim() || this.settings.apiKey.trim()
    };
  }

  private async collectControlledTags(): Promise<string[]> {
    if (!this.settings.useControlledTags) {
      return [];
    }

    const fromSettings = this.settings.tagTaxonomy
      .split(/[\n,]/)
      .map((tag) => sanitizeTag(tag))
      .filter(Boolean);
    const vaultTags: string[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      if (!frontmatter) {
        continue;
      }
      vaultTags.push(...asStringArray(frontmatter.tags).map((tag) => sanitizeTag(tag)));
      if (vaultTags.length >= 200) {
        break;
      }
    }
    return uniqueStrings([...fromSettings, ...vaultTags]).slice(0, 200);
  }

  private normalizeTags(rawTags: string[], category: string, sourceType: SourceType): string[] {
    const prefix = sanitizeTag(this.settings.tagPrefix || "amem") || "amem";
    const prefixed = rawTags
      .map((tag) => sanitizeTag(tag))
      .filter(Boolean)
      .map((tag) => tag === prefix || tag.startsWith(`${prefix}/`) ? tag : `${prefix}/${tag}`);
    const mandatory = [
      prefix,
      `${prefix}/source/${sanitizeTag(sourceType) || "unknown"}`,
      `${prefix}/category/${sanitizeTag(category) || "general"}`
    ];
    return uniqueStrings([...mandatory, ...prefixed]).slice(0, 12);
  }

  private embeddingTextForGenerated(note: GeneratedNote): string {
    return truncate(`${note.title}\n${note.content}\nContext: ${note.context}\nKeywords: ${note.keywords.join(", ")}\nTags: ${note.tags.join(", ")}`, 6000);
  }

  private embeddingTextForEntry(entry: IndexEntry): string {
    return truncate(`${entry.title}\n${entry.contentPreview}\nContext: ${entry.context}\nKeywords: ${entry.keywords.join(", ")}\nTags: ${entry.tags.join(", ")}`, 6000);
  }

  private async backfillIndexEmbeddings(index: AMemIndex): Promise<void> {
    const missing = index.notes.filter((entry) => !isVector(entry.embedding)).slice(0, 50);
    if (!missing.length) {
      return;
    }
    const vectors = await this.embedMany(missing.map((entry) => this.embeddingTextForEntry(entry)));
    missing.forEach((entry, position) => {
      entry.embedding = vectors[position];
    });
  }

  private renderNote(
    entry: IndexEntry,
    note: GeneratedNote,
    source: SourceDocument,
    timestamp: string,
    links: IndexEntry[]
  ): string {
    const sourceLines = renderSourceLines(source);
    const linkLines = links.length
      ? links.map((link) => `- ${wikilink(link.path, link.title)} <!-- amem-link:${link.id} -->`).join("\n")
      : "- No related A-mem notes were connected during this ingestion.";

    return `---
id: ${yamlString(entry.id)}
amem: true
note_type: ${yamlString(entry.noteType)}
category: ${yamlString(entry.category)}
tags:
${yamlArray(entry.tags)}
keywords:
${yamlArray(entry.keywords)}
context: ${yamlString(entry.context)}
source_type: ${yamlString(source.type)}
source_path: ${yamlString(source.sourcePath ?? "")}
source_url: ${yamlString(source.sourceUrl ?? "")}
source_anchor: ${yamlString(note.sourceAnchor ?? source.sourceAnchor ?? "")}
timestamp: ${yamlString(timestamp)}
created: ${yamlString(entry.createdAt)}
last_accessed: ${yamlString(entry.createdAt)}
retrieval_count: 0
links:
${yamlArray(entry.links)}
evolution_history: []
---

# ${note.title}

${note.content.trim()}

## Context

${note.context}

## Keywords

${entry.keywords.map((keyword) => `- ${keyword}`).join("\n")}

## Links

${linkLines}

## Source

${sourceLines.join("\n")}
`;
  }

  private async updateNeighbor(
    neighbor: IndexEntry,
    newEntry: IndexEntry,
    update: NeighborUpdate | undefined,
    timestamp: string
  ): Promise<void> {
    const abstract = this.app.vault.getAbstractFileByPath(neighbor.path);
    if (!(abstract instanceof TFile)) {
      return;
    }

    const refinedTags = update?.tags?.length
      ? this.normalizeTags(update.tags, neighbor.category, "file")
      : [];

    await this.app.fileManager.processFrontMatter(abstract, (frontmatter) => {
      const metadata = frontmatter as Record<string, unknown>;
      const links = uniqueStrings([...asStringArray(metadata.links), newEntry.id]);
      metadata.links = links;
      metadata.last_accessed = new Date().toISOString();
      metadata.retrieval_count = Math.max(0, Number(metadata.retrieval_count ?? 0) || 0) + 1;

      if (update?.context?.trim()) {
        metadata.context = update.context.trim();
        neighbor.context = update.context.trim();
      }
      if (refinedTags.length) {
        metadata.tags = uniqueStrings([...asStringArray(metadata.tags), ...refinedTags]);
        neighbor.tags = uniqueStrings([...neighbor.tags, ...refinedTags]);
      }

      const history = Array.isArray(metadata.evolution_history) ? metadata.evolution_history : [];
      history.push({
        at: timestamp,
        action: update ? "update_neighbor+strengthen" : "strengthen",
        related_note: newEntry.id
      });
      metadata.evolution_history = history.slice(-30);
      neighbor.links = links;
    });

    const content = await this.app.vault.read(abstract);
    const marker = `<!-- amem-link:${newEntry.id} -->`;
    if (!content.includes(marker)) {
      const line = `- ${wikilink(newEntry.path, newEntry.title)} ${marker}`;
      await this.app.vault.modify(abstract, appendToLinksSection(content, line));
    }
  }

  private async ensureFolder(folder: string): Promise<void> {
    const cleanFolder = normalizePath(folder.replace(/^\/+|\/+$/g, ""));
    if (!cleanFolder) {
      throw new Error("notesFolder 不能为空。");
    }
    const parts = cleanFolder.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private indexPath(): string {
    return normalizePath(`${this.settings.notesFolder}/.amem-index.json`);
  }

  private mocPath(): string {
    return normalizePath(`${this.settings.notesFolder}/_A-mem MOC.md`);
  }

  private async loadIndex(): Promise<AMemIndex> {
    const file = this.app.vault.getAbstractFileByPath(this.indexPath());
    if (file instanceof TFile) {
      try {
        const parsed = JSON.parse(await this.app.vault.read(file)) as Partial<AMemIndex>;
        if (Array.isArray(parsed.notes)) {
          return {
            version: 1,
            updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
            notes: parsed.notes.map(coerceIndexEntry).filter((entry): entry is IndexEntry => Boolean(entry))
          };
        }
      } catch (error) {
        console.warn("A-mem index was invalid; rebuilding from vault metadata", error);
      }
    }
    return this.indexFromVault();
  }

  private indexFromVault(): AMemIndex {
    const folder = normalizePath(this.settings.notesFolder).replace(/\/+$/, "");
    const notes: IndexEntry[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(`${folder}/`) || file.path === this.mocPath()) {
        continue;
      }
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      if (!frontmatter || frontmatter.amem !== true) {
        continue;
      }
      const entry = coerceIndexEntry({
        id: frontmatter.id,
        path: file.path,
        title: file.basename,
        context: frontmatter.context,
        keywords: frontmatter.keywords,
        tags: frontmatter.tags,
        category: frontmatter.category,
        noteType: frontmatter.note_type,
        createdAt: frontmatter.created,
        links: frontmatter.links,
        contentPreview: "",
        embedding: undefined
      });
      if (entry) {
        notes.push(entry);
      }
    }
    return { version: 1, updatedAt: new Date().toISOString(), notes };
  }

  private async saveIndex(index: AMemIndex): Promise<void> {
    const content = JSON.stringify(index, null, 2);
    const file = this.app.vault.getAbstractFileByPath(this.indexPath());
    if (file instanceof TFile) {
      await this.app.vault.modify(file, content);
    } else {
      await this.app.vault.create(this.indexPath(), content);
    }
  }

  private async writeMoc(index: AMemIndex): Promise<void> {
    const groups = new Map<string, IndexEntry[]>();
    for (const entry of index.notes) {
      const category = entry.category || "General";
      const current = groups.get(category) ?? [];
      current.push(entry);
      groups.set(category, current);
    }

    const sections = [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, entries]) => {
        const lines = entries
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map((entry) => `- ${wikilink(entry.path, entry.title)} — ${entry.context}`);
        return `## ${category}\n\n${lines.join("\n")}`;
      });

    const content = `---
amem_moc: true
updated: ${yamlString(new Date().toISOString())}
---

# A-mem MOC

> Automatically maintained by **A-mem Notes**. It indexes ${index.notes.length} generated memory notes.

${sections.join("\n\n") || "_No A-mem notes yet._"}
`;
    const file = this.app.vault.getAbstractFileByPath(this.mocPath());
    if (file instanceof TFile) {
      await this.app.vault.modify(file, content);
    } else {
      await this.app.vault.create(this.mocPath(), content);
    }
  }

  private async uniqueNotePath(title: string, timestamp: string, id: string): Promise<string> {
    const folder = normalizePath(this.settings.notesFolder).replace(/\/+$/, "");
    const slug = slugify(title) || "memory";
    const prefix = `${timestamp.slice(0, 8)}-${timestamp.slice(8, 12)}-${slug}-${id.slice(-6)}`;
    let candidate = normalizePath(`${folder}/${prefix}.md`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${folder}/${prefix}-${suffix}.md`);
      suffix += 1;
    }
    return candidate;
  }
}

class AMemChatView extends ItemView {
  private readonly history: ChatMessage[] = [];
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: AMemNotesPlugin) { super(leaf); }
  getViewType(): string { return CHAT_VIEW_TYPE; }
  getDisplayText(): string { return "Auto-Zettelkasten chat"; }
  getIcon(): string { return "message-circle"; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty(); root.addClass("amem-chat");
    root.createEl("h4", { text: "Ask your A-mem notes" });
    root.createEl("p", { text: "Answers use retrieved notes. History stays in this pane only." });
    this.messagesEl = root.createDiv({ cls: "amem-chat-messages" });
    this.addMessage("assistant", "Ask a question about the notes in your A-mem folder.");
    this.inputEl = root.createEl("textarea", { cls: "amem-chat-input", placeholder: "Ask about your notes…" });
    this.inputEl.rows = 4;
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void this.submit(); }
    });
    const actions = root.createDiv({ cls: "amem-chat-actions" });
    const clear = actions.createEl("button", { text: "Clear" });
    clear.addEventListener("click", () => this.clear());
    this.sendButton = actions.createEl("button", { text: "Ask", cls: "mod-cta" });
    this.sendButton.addEventListener("click", () => void this.submit());
  }

  private clear(): void {
    this.history.length = 0; this.messagesEl.empty();
    this.addMessage("assistant", "Chat cleared. Ask another question about your notes.");
  }

  private async submit(): Promise<void> {
    const question = this.inputEl.value.trim();
    if (!question || this.sendButton.disabled) return;
    this.addMessage("user", question); this.history.push({ role: "user", content: question }); this.inputEl.value = "";
    this.sendButton.disabled = true; this.sendButton.setText("Searching notes…");
    try {
      const result = await this.plugin.getMemoryService().answerQuestion(question, this.history);
      this.addMessage("assistant", result.answer, result.sources);
      this.history.push({ role: "assistant", content: result.answer });
    } catch (error) {
      this.addMessage("assistant", `Unable to answer: ${errorMessage(error)}`);
    } finally {
      this.sendButton.disabled = false; this.sendButton.setText("Ask"); this.inputEl.focus();
    }
  }

  private addMessage(role: ChatMessage["role"], text: string, sources: Neighbor[] = []): void {
    const message = this.messagesEl.createDiv({ cls: `amem-chat-message amem-chat-${role}` });
    message.createDiv({ cls: "amem-chat-role", text: role === "user" ? "You" : "Auto-Zettelkasten" });
    message.createDiv({ cls: "amem-chat-text", text });
    if (sources.length) {
      const list = message.createDiv({ cls: "amem-chat-sources" }); list.createEl("strong", { text: "Retrieved notes" });
      for (const [index, source] of sources.entries()) {
        const link = list.createEl("a", { text: `[${index + 1}] ${source.entry.title}`, href: source.entry.path });
        link.addEventListener("click", (event) => { event.preventDefault(); void this.app.workspace.openLinkText(source.entry.path.replace(/\.md$/i, ""), "", true); });
      }
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}

class AMemSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: AMemNotesPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Auto-Zettelkasten" });
    containerEl.createEl("p", {
      text: "Use an OpenAI-compatible chat + embeddings API to create linked, atomic A-mem memory notes inside this vault."
    });

    new Setting(containerEl)
      .setName("OpenAI-compatible base URL")
      .setDesc("Usually ends in /v1. Examples: OpenAI, DeepSeek, Moonshot/Kimi, or another compatible service.")
      .addText((text) => text
        .setPlaceholder("https://api.openai.com/v1")
        .setValue(this.plugin.settings.baseUrl)
        .onChange(async (value) => {
          this.plugin.settings.baseUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Stored in Obsidian plugin data. Use a restricted key where your provider supports it.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-…")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Chat model")
      .setDesc("Must support chat completions and preferably JSON-object output.")
      .addText((text) => text
        .setValue(this.plugin.settings.chatModel)
        .onChange(async (value) => {
          this.plugin.settings.chatModel = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc("Used to retrieve nearest A-mem notes before the LLM makes a linking/evolution decision.")
      .addText((text) => text
        .setValue(this.plugin.settings.embeddingModel)
        .onChange(async (value) => {
          this.plugin.settings.embeddingModel = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Embedding base URL (optional)")
      .setDesc("Leave empty to use the chat base URL. Set this when your chat provider does not expose an /embeddings endpoint.")
      .addText((text) => text
        .setPlaceholder("https://api.openai.com/v1")
        .setValue(this.plugin.settings.embeddingBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.embeddingBaseUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Embedding API key (optional)")
      .setDesc("Leave empty to use the chat API key. Use a separate key when embeddings are provided by another service.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-…")
          .setValue(this.plugin.settings.embeddingApiKey)
          .onChange(async (value) => {
            this.plugin.settings.embeddingApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "Vault output" });

    new Setting(containerEl)
      .setName("A-mem notes folder")
      .setDesc("Relative path inside this vault. Generated notes, MOC, and a hidden semantic index are stored here.")
      .addText((text) => text
        .setValue(this.plugin.settings.notesFolder)
        .onChange(async (value) => {
          this.plugin.settings.notesFolder = value.trim() || DEFAULT_SETTINGS.notesFolder;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Tag prefix")
      .setDesc("All generated tags are namespaced under this prefix, for example amem/research.")
      .addText((text) => text
        .setValue(this.plugin.settings.tagPrefix)
        .onChange(async (value) => {
          this.plugin.settings.tagPrefix = value.trim() || "amem";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Output language")
      .setDesc("Controls note titles, content, context, keywords, and tags.")
      .addDropdown((dropdown) => dropdown
        .addOption("auto", "Auto (source language)")
        .addOption("zh", "Chinese")
        .addOption("en", "English")
        .setValue(this.plugin.settings.language)
        .onChange(async (value) => {
          this.plugin.settings.language = value as NoteLanguage;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl("h3", { text: "Tagging and evolution" });

    new Setting(containerEl)
      .setName("Use controlled tag vocabulary")
      .setDesc("Pass your tag taxonomy and existing frontmatter tags to the LLM so it reuses stable names when appropriate.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.useControlledTags)
        .onChange(async (value) => {
          this.plugin.settings.useControlledTags = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Tag taxonomy")
      .setDesc("Comma- or line-separated preferred tags. The model may add a new precise tag when needed.")
      .addTextArea((text) => text
        .setValue(this.plugin.settings.tagTaxonomy)
        .onChange(async (value) => {
          this.plugin.settings.tagTaxonomy = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Auto-link and A-mem evolution")
      .setDesc("Embed new notes, retrieve nearest neighbors, then ask the LLM whether to strengthen links or refine taxonomy.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoLink)
        .onChange(async (value) => {
          this.plugin.settings.autoLink = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Refine linked neighbor metadata")
      .setDesc("When A-mem chooses update_neighbor, add refined context/tags and an evolution-history item to existing linked notes.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.updateNeighbors)
        .onChange(async (value) => {
          this.plugin.settings.updateNeighbors = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Maintain A-mem MOC")
      .setDesc("Create/update _A-mem MOC.md after every ingestion.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.createMoc)
        .onChange(async (value) => {
          this.plugin.settings.createMoc = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl("h3", { text: "Limits" });
    this.addNumberSetting(containerEl, "Maximum notes per ingestion", "Hard cap to control cost and note volume.", "maxNotesPerIngest", 1, 100);
    this.addNumberSetting(containerEl, "Maximum characters per source chunk", "Long sources are split by paragraphs before note generation.", "maxChunkCharacters", 2000, 50000);
    this.addNumberSetting(containerEl, "Chunk overlap characters", "Context retained between adjacent chunks. Set 0 to disable overlap.", "chunkOverlapCharacters", 0, 5000);
    this.addNumberSetting(containerEl, "Nearest neighbors", "How many existing A-mem notes are sent to the evolution step.", "maxNeighbors", 1, 12);
    this.addNumberSetting(containerEl, "Chat retrieval count", "How many matching A-mem notes are given to the chatbot for each answer.", "chatRetrievalCount", 1, 12);
    this.addNumberSetting(containerEl, "Minimum similarity", "Cosine similarity threshold (0 to 1) before a note becomes a candidate neighbor.", "minSimilarity", 0, 1, true);
  }

  private addNumberSetting(
    containerEl: HTMLElement,
    name: string,
    description: string,
    key: "maxNotesPerIngest" | "maxChunkCharacters" | "chunkOverlapCharacters" | "maxNeighbors" | "minSimilarity" | "chatRetrievalCount",
    minimum: number,
    maximum: number,
    decimal = false
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = String(minimum);
        text.inputEl.max = String(maximum);
        text.inputEl.step = decimal ? "0.01" : "1";
        text.setValue(String(this.plugin.settings[key]));
        text.onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed)) {
            return;
          }
          this.plugin.settings[key] = Math.min(maximum, Math.max(minimum, decimal ? parsed : Math.round(parsed))) as never;
          await this.plugin.saveSettings();
        });
      });
  }
}

class UrlPromptModal extends Modal {
  constructor(
    app: App,
    private readonly onSubmit: (url: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.addClass("amem-url-modal");
    this.contentEl.createEl("h2", { text: "Ingest article URL" });
    this.contentEl.createEl("p", { text: "A-mem Notes will fetch the article, extract readable text, and create linked atomic notes." });
    const input = this.contentEl.createEl("input", {
      type: "url",
      placeholder: "https://example.com/article"
    });
    input.focus();

    const submit = (): void => {
      const url = input.value.trim();
      if (!url) {
        new Notice("A-mem：请输入文章 URL。");
        return;
      }
      this.close();
      this.onSubmit(url);
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Ingest").setCta().onClick(submit));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function coerceGeneratedNote(raw: unknown, fallbackTitle: string): GeneratedNote | null {
  if (!isRecord(raw)) {
    return null;
  }
  const content = stringValue(raw.content).trim();
  if (content.length < 10) {
    return null;
  }
  const title = cleanTitle(stringValue(raw.title) || firstMeaningfulLine(content) || fallbackTitle);
  const keywords = uniqueStrings(asStringArray(raw.keywords)).slice(0, 12);
  const tags = uniqueStrings(asStringArray(raw.tags)).slice(0, 10);
  return {
    title,
    content,
    keywords: keywords.length ? keywords : extractFallbackKeywords(title, content),
    context: stringValue(raw.context).trim() || `A memory note derived from ${fallbackTitle}.`,
    tags: tags.length ? tags : ["insight", "source"],
    category: cleanTitle(stringValue(raw.category) || "General"),
    noteType: sanitizeTag(stringValue(raw.note_type) || stringValue(raw.noteType) || "insight") || "insight",
    importance: clampInteger(raw.importance, 1, 5, 3),
    sourceAnchor: stringValue(raw.source_anchor || raw.sourceAnchor).trim() || undefined
  };
}

function coerceEvolutionDecision(payload: unknown, allowedIds: Set<string>): EvolutionDecision {
  if (!isRecord(payload) || payload.should_evolve !== true) {
    return emptyEvolutionDecision();
  }
  const suggestedConnections = uniqueStrings(asStringArray(payload.suggested_connections))
    .filter((id) => allowedIds.has(id));
  const updates = new Map<string, NeighborUpdate>();

  for (const item of asObjectArray(payload.new_context_neighborhood)) {
    const id = stringValue(item.id);
    const context = stringValue(item.context).trim();
    if (allowedIds.has(id) && context) {
      updates.set(id, { ...(updates.get(id) ?? {}), context });
    }
  }
  for (const item of asObjectArray(payload.new_tags_neighborhood)) {
    const id = stringValue(item.id);
    const tags = uniqueStrings(asStringArray(item.tags));
    if (allowedIds.has(id) && tags.length) {
      updates.set(id, { ...(updates.get(id) ?? {}), tags });
    }
  }

  return {
    shouldEvolve: true,
    actions: uniqueStrings(asStringArray(payload.actions)),
    suggestedConnections,
    tagsToUpdate: uniqueStrings(asStringArray(payload.tags_to_update)),
    neighborUpdates: updates
  };
}

function emptyEvolutionDecision(): EvolutionDecision {
  return {
    shouldEvolve: false,
    actions: [],
    suggestedConnections: [],
    tagsToUpdate: [],
    neighborUpdates: new Map()
  };
}

function coerceIndexEntry(raw: unknown): IndexEntry | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = stringValue(raw.id);
  const path = stringValue(raw.path);
  if (!id || !path) {
    return null;
  }
  const embedding = Array.isArray(raw.embedding) && raw.embedding.every((value) => typeof value === "number")
    ? raw.embedding as number[]
    : undefined;
  return {
    id,
    path,
    title: cleanTitle(stringValue(raw.title) || path.replace(/^.*\//, "").replace(/\.md$/, "")),
    context: stringValue(raw.context),
    keywords: uniqueStrings(asStringArray(raw.keywords)),
    tags: uniqueStrings(asStringArray(raw.tags)),
    category: cleanTitle(stringValue(raw.category) || "General"),
    noteType: sanitizeTag(stringValue(raw.noteType || raw.note_type) || "insight") || "insight",
    createdAt: stringValue(raw.createdAt || raw.created) || new Date(0).toISOString(),
    links: uniqueStrings(asStringArray(raw.links)),
    contentPreview: stringValue(raw.contentPreview),
    embedding
  };
}

function rankNeighbors(
  note: GeneratedNote,
  embedding: number[] | undefined,
  entries: IndexEntry[],
  maximum: number,
  minimumSimilarity: number
): Neighbor[] {
  const query = `${note.title} ${note.context} ${note.keywords.join(" ")} ${note.tags.join(" ")} ${note.content}`;
  const ranked = entries.map((entry) => {
    const score = isVector(embedding) && isVector(entry.embedding)
      ? cosineSimilarity(embedding, entry.embedding)
      : lexicalSimilarity(query, `${entry.title} ${entry.context} ${entry.keywords.join(" ")} ${entry.tags.join(" ")} ${entry.contentPreview}`);
    return { entry, score };
  });
  const threshold = ranked.some(({ entry }) => isVector(embedding) && isVector(entry.embedding))
    ? minimumSimilarity
    : Math.min(minimumSimilarity, 0.15);
  return ranked
    .filter((neighbor) => neighbor.score >= threshold)
    .sort((left, right) => right.score - left.score)
    .slice(0, maximum);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || !left.length) {
    return 0;
  }
  let dot = 0;
  let leftLength = 0;
  let rightLength = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftLength += left[index] * left[index];
    rightLength += right[index] * right[index];
  }
  if (!leftLength || !rightLength) {
    return 0;
  }
  return dot / Math.sqrt(leftLength * rightLength);
}

function lexicalSimilarity(left: string, right: string): number {
  const leftTerms = new Set(tokenize(left));
  const rightTerms = new Set(tokenize(right));
  if (!leftTerms.size || !rightTerms.size) {
    return 0;
  }
  let intersection = 0;
  for (const term of leftTerms) {
    if (rightTerms.has(term)) {
      intersection += 1;
    }
  }
  return intersection / Math.sqrt(leftTerms.size * rightTerms.size);
}

function tokenize(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_/-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 2000);
}

function deduplicateNotes(notes: GeneratedNote[]): GeneratedNote[] {
  const known = new Map<string, GeneratedNote>();
  for (const note of notes) {
    const key = `${normalizeComparable(note.title)}|${normalizeComparable(note.content).slice(0, 240)}`;
    const existing = known.get(key);
    if (!existing) {
      known.set(key, note);
      continue;
    }
    existing.keywords = uniqueStrings([...existing.keywords, ...note.keywords]);
    existing.tags = uniqueStrings([...existing.tags, ...note.tags]);
    existing.importance = Math.max(existing.importance, note.importance);
  }
  return [...known.values()];
}

function splitIntoChunks(text: string, maximumCharacters: number, overlapCharacters: number): string[] {
  const maximum = Math.max(2000, maximumCharacters || DEFAULT_SETTINGS.maxChunkCharacters);
  const overlap = Math.max(0, Math.min(overlapCharacters || 0, Math.floor(maximum / 3)));
  if (text.length <= maximum) {
    return [text];
  }

  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > maximum) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let start = 0; start < paragraph.length; start += maximum - overlap || maximum) {
        chunks.push(paragraph.slice(start, start + maximum));
      }
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maximum) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      const tail = overlap ? current.slice(-overlap) : "";
      current = tail ? `${tail}\n\n${paragraph}` : paragraph;
    } else {
      current = paragraph;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function parseModelJson(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch (_error) {
    const start = cleaned.search(/[\[{]/);
    if (start < 0) {
      throw new Error("模型输出不是 JSON。");
    }
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const character = cleaned[index];
      if (quoted) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          quoted = false;
        }
        continue;
      }
      if (character === '"') {
        quoted = true;
      } else if (character === "{" || character === "[") {
        depth += 1;
      } else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) {
          return JSON.parse(cleaned.slice(start, index + 1));
        }
      }
    }
    throw new Error("模型 JSON 不完整。");
  }
}

function extractArticleFromHtml(html: string, fallbackUrl: string): { title: string; text: string; publishedAt?: string } {
  const document = new DOMParser().parseFromString(html, "text/html");
  if (!document) {
    return { title: "", text: "" };
  }
  const title = metaContent(document, ["og:title", "twitter:title"], ["property", "name"])
    || document.querySelector("title")?.textContent?.trim()
    || document.querySelector("h1")?.textContent?.trim()
    || fallbackUrl;
  const publishedAt = metaContent(document, ["article:published_time", "date", "publish-date"], ["property", "name"]);

  document.querySelectorAll("script, style, noscript, nav, footer, header, aside, form, svg, iframe").forEach((element) => element.remove());
  const root = document.querySelector("article, main, [role='main'], .article-content, .post-content, .entry-content") || document.body;
  const blocks = Array.from(root.querySelectorAll("h1, h2, h3, h4, p, li, blockquote, pre"))
    .map((element) => element.textContent?.replace(/\s+/g, " ").trim() || "")
    .filter((text) => text.length >= 20);
  const text = blocks.length ? blocks.join("\n\n") : (root.textContent || "").replace(/\s+/g, " ").trim();
  return { title: cleanTitle(title), text, publishedAt: publishedAt || undefined };
}

function metaContent(document: Document, names: string[], attributes: string[]): string {
  for (const name of names) {
    for (const attribute of attributes) {
      const element = document.querySelector(`meta[${attribute}="${name}"]`);
      const content = element?.getAttribute("content")?.trim();
      if (content) {
        return content;
      }
    }
  }
  return "";
}

function renderSourceLines(source: SourceDocument): string[] {
  const lines = [`- Type: ${source.type}`, `- Captured: ${source.capturedAt}`];
  if (source.sourcePath) {
    lines.push(`- File: ${wikilink(source.sourcePath, source.title)}`);
  }
  if (source.sourceUrl) {
    lines.push(`- URL: ${source.sourceUrl}`);
  }
  if (source.sourceAnchor) {
    lines.push(`- Anchor: ${source.sourceAnchor}`);
  }
  return lines;
}

function appendToLinksSection(content: string, line: string): string {
  const match = /^## Links\s*$/m.exec(content);
  if (!match || match.index === undefined) {
    return `${content.trimEnd()}\n\n## Links\n\n${line}\n`;
  }
  const sectionStart = match.index + match[0].length;
  const nextHeading = /\n##\s+/g;
  nextHeading.lastIndex = sectionStart;
  const next = nextHeading.exec(content);
  const insertion = next ? next.index : content.length;
  const before = content.slice(0, insertion).replace(/\s*$/, "");
  const after = content.slice(insertion);
  return `${before}\n${line}\n${after}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value ?? "");
}

function yamlArray(values: string[]): string {
  if (!values.length) {
    return "  []";
  }
  return values.map((value) => `  - ${yamlString(value)}`).join("\n");
}

function wikilink(path: string, title: string): string {
  const target = path.replace(/\.md$/i, "").replace(/\]\]/g, "");
  const alias = title.replace(/[\[\]]/g, "");
  return `[[${target}|${alias}]]`;
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");
}

function cleanInput(text: string): string {
  return text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function cleanTitle(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/^#+\s*/, "").replace(/\s+/g, " ").trim().slice(0, 140) || "Untitled memory";
}

function firstMeaningfulLine(content: string): string {
  return content.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length >= 4) || "";
}

function extractFallbackKeywords(title: string, content: string): string[] {
  return uniqueStrings(tokenize(`${title} ${content}`).filter((term) => term.length >= 3)).slice(0, 5);
}

function sanitizeTag(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/^#+/, "")
    .replace(/\s+/g, "-")
    .replace(/[\\^:|?*\[\]{}(),;'\"]/g, "")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

function normalizeComparable(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLocaleLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function asObjectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function createMemoryId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `amem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function amemTimestamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
