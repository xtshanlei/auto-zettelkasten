# Auto-Zettelkasten for Obsidian

**English** — Auto-Zettelkasten turns conversations, files in an Obsidian vault, clipboard text, and web articles into reusable atomic notes. Inspired by [A-MEM: Agentic Memory for LLM Agents](https://github.com/agiresearch/A-mem), it automatically generates metadata and tags, retrieves related notes, creates bidirectional wikilinks, and performs lightweight memory evolution.

**中文** — Auto-Zettelkasten 将对话、Obsidian vault 内的文件、剪贴板文本和网页文章转换成一组可复用的原子笔记（atomic notes）。它借鉴 [A-MEM: Agentic Memory for LLM Agents](https://github.com/agiresearch/A-mem) 的思路，自动生成元数据和标签、检索相关笔记、建立双向链接，并进行轻量的记忆演化。

> This is an **Obsidian Community plugin project**, not a wrapper around the A-mem Python repository. It maps A-mem's `MemoryNote` metadata, nearest-neighbor retrieval, and `strengthen` / `update_neighbor` evolution operations to Obsidian Markdown, YAML frontmatter, and wikilinks.
>
> 这是一个 **Obsidian 社区插件项目**，不是 A-mem Python 仓库的封装。它把 A-mem 的 `MemoryNote` 元数据、近邻检索和 `strengthen` / `update_neighbor` 演化流程映射到 Obsidian Markdown、YAML frontmatter 和 wikilinks。

## Features / 已实现功能

### Chatbot over notes / 基于 notes 的问答

- **English** — Open the chatbot with the `Auto-Zettelkasten: Open notes chatbot` command or the sidebar message icon. It embeds your question, retrieves the most relevant A-mem notes, answers only from those notes, and links to each source. Retrievals update each note's `retrieval_count` and `last_accessed`. Chat history stays in the sidebar session and is not written to the vault.
- **中文** — 通过命令面板的 `Auto-Zettelkasten: Open notes chatbot` 或侧栏消息图标打开。插件对问题生成 embedding，从 A-mem 索引检索最相关的 notes，再仅依据这些内容回答，并附上可点击的来源笔记。每次检索会更新对应 note 的 `retrieval_count` 与 `last_accessed`。聊天记录默认只存在当前侧栏会话，不会写入 Vault。

### Input sources / 输入入口

- **English** — Vault files (Markdown, TXT, HTML, JSON, CSV) via the command or the file context menu; the current editor selection; clipboard text; and article URLs fetched through Obsidian `requestUrl`.
- **中文** — 通过命令或文件右键菜单处理 vault 内的文件（Markdown、TXT、HTML、JSON、CSV）；支持编辑器选中文本、剪贴板文本，以及通过 Obsidian `requestUrl` 获取的网页文章 URL。

### A-mem-style note generation / A-mem 风格 note 生成

- **English** — Splits long content into chunks and asks the LLM to produce independent, retrievable atomic notes. Each note stores `content`, `keywords`, `context`, `category`, `tags`, timestamps, retrieval counts, links, and evolution history.
- **中文** — 将较长内容按段落分块，并要求 LLM 产出多个独立、可检索的 atomic notes。每条 note 都含有 `content`、`keywords`、`context`、`category`、`tags`、时间戳、检索次数、链接和演化历史。

### Lightweight A-mem evolution / 轻量 A-mem 演化

- **English** — Embeds new and existing notes, takes the Top-K neighbors, then asks the LLM to make A-mem-aligned `strengthen` / `update_neighbor` decisions. It creates bidirectional wikilinks and optionally updates existing notes' `context`, `tags`, `retrieval_count`, and `evolution_history`.
- **中文** — 对新 note 和既有 note 调用 OpenAI-compatible embeddings，取 Top-K 近邻后，让 LLM 作出与 A-mem 对齐的 `strengthen` / `update_neighbor` 决策；建立双向 `[[wikilink]]`，并可更新旧 note 的 `context`、`tags`、`retrieval_count` 和 `evolution_history`。

### Maintenance / 自动维护

- **English** — Maintains `A-mem/_A-mem MOC.md` and persists a lightweight semantic index in `A-mem/_amem-index.json`.
- **中文** — 自动维护 `A-mem/_A-mem MOC.md`，并在 `A-mem/_amem-index.json` 中保存轻量检索索引和向量。

## Installation / 安装

### 1. Build / 构建

**English** — Run these commands in the project directory:

**中文** — 在本项目目录执行：

```bash
npm install
npm run build
```

### 2. Install into your vault / 安装到你的 vault

**English** — Create the target folder:

**中文** — 创建目标目录：

```text
<your Obsidian vault>/.obsidian/plugins/auto-zettelkasten/
```

**English** — Copy the build artifacts into that folder, then enable the plugin.

**中文** — 将以下构建产物复制到该目录，然后启用插件。

```text
main.js
manifest.json
styles.css
```

**English** — In Obsidian: open **Settings → Community plugins**, disable Restricted mode if needed, refresh the community plugin list, and enable **Auto-Zettelkasten**.

**中文** — 在 Obsidian 中：打开 **Settings → Community plugins**，如有需要先关闭 Restricted mode，刷新社区插件列表并启用 **Auto-Zettelkasten**。

> **English** — For development, link or copy this project into the plugin folder, run `npm run build` after each change, then reload the plugin.
>
> **中文** — 开发时，可以把此项目目录直接链接或复制到上述插件目录；每次修改后运行 `npm run build`，然后在 Obsidian 中重新加载插件。

## Model configuration / 配置模型

**English** — Open **Settings → Auto-Zettelkasten** and fill in:

**中文** — 打开 **Settings → Auto-Zettelkasten**，填写：

| Setting / 配置项 | Description / 说明 |
| --- | --- |
| `OpenAI-compatible base URL` | Root URL of the chat service, usually ending in `/v1`. The plugin calls `POST /chat/completions`. 聊天模型服务的根 URL，通常以 `/v1` 结尾。 |
| `API key` | Chat model API key; use a restricted key where possible. 聊天模型 API key，建议使用可限制额度/权限的 key。 |
| `Chat model` | A chat model that can return structured JSON. 能稳定返回 JSON 的对话模型。 |
| `Embedding model` | Used for nearest-neighbor retrieval. 用于近邻检索的 embedding 模型。 |
| `Embedding base URL / API key` | Optional. Set these when your chat provider does not expose `/embeddings`; leave empty to reuse the chat URL and key. 可选。如果聊天供应商没有 `/embeddings`，可单独填写另一个 OpenAI-compatible embedding 服务；留空则复用聊天 URL 与 key。 |

**English** — Chat and embedding APIs can be different services. If embedding fails, notes are still created with tags and the plugin falls back to keyword similarity.

**中文** — 聊天和 embedding API 可以分开：例如用支持 `/chat/completions` 的模型生成笔记，再使用另一个兼容 `/embeddings` 的服务建立关联。如果 embedding 调用失败，插件仍会生成带标签的笔记，并降级为关键词相似度。

## Usage / 使用方法

### Conversations / 对话

**English** — Copy a conversation, then run `Auto-Zettelkasten: Ingest clipboard text as A-mem notes`. Alternatively, export the conversation as Markdown/JSON into the vault and run `Auto-Zettelkasten: Ingest current file as A-mem notes`.

**中文** — 复制对话内容后，运行 `Auto-Zettelkasten: Ingest clipboard text as A-mem notes`。或者将对话导出为 Markdown/JSON 放入 vault，再对该文件运行 `Auto-Zettelkasten: Ingest current file as A-mem notes`。

> **English** — An Obsidian plugin cannot read the current conversation state of an external web/desktop app (including the DSH GUI). Clipboard and exported chat files are the one-click entry points today.
>
> **中文** — Obsidian 插件无法直接读取外部网页/桌面应用（包括 DSH GUI）的当前对话状态；剪贴板和聊天导出文件是当前的一键入口。

### Files and articles / 文件与文章

- **English** — Open a vault text file and run `Auto-Zettelkasten: Ingest current file as A-mem notes`.
- **中文** — 打开 vault 中的文本文件，运行 `Auto-Zettelkasten: Ingest current file as A-mem notes`。
- **English** — Right-click a file in the file explorer and choose `Create A-mem notes from this file`.
- **中文** — 或在文件资源管理器中右键文件，选择 `Create A-mem notes from this file`。
- **English** — Select text and run `Auto-Zettelkasten: Ingest selected text as A-mem notes`.
- **中文** — 选中一段内容，运行 `Auto-Zettelkasten: Ingest selected text as A-mem notes`。
- **English** — Run `Auto-Zettelkasten: Ingest web article URL as A-mem notes` and enter a URL.
- **中文** — 运行 `Auto-Zettelkasten: Ingest web article URL as A-mem notes` 并输入文章 URL。

**English** — Markdown, TXT, HTML, JSON, and CSV are supported directly. Convert PDFs to Markdown or plain text first. Dynamically rendered pages may need their content saved manually.

**中文** — 当前直接支持 Markdown、TXT、HTML、JSON、CSV。PDF 需先用 OCR/文本提取器转换为 Markdown 或纯文本；动态渲染且正文不在初始 HTML 中的网站也可能需要先保存正文。

## Output structure / 输出结构

**English** — Notes are written to `A-mem/` by default:

**中文** — 默认写入 vault 的 `A-mem/` 目录：

```text
A-mem/
├── 20250308-1530-example-note-a1b2c3.md
├── 20250308-1531-another-note-d4e5f6.md
├── _A-mem MOC.md
└── _amem-index.json
```

**English** — A generated note looks like:

**中文** — 每条生成笔记类似：

```markdown
---
id: "uuid"
amem: true
note_type: "insight"
category: "Research"
tags:
  - "amem"
  - "amem/source/article"
  - "amem/category/research"
  - "amem/agent-memory"
keywords:
  - "A-mem"
  - "Zettelkasten"
context: "…"
links:
  - "related-memory-id"
evolution_history: []
---

# 笔记标题

独立、可复用的笔记正文。

## Links

- [[A-mem/相关笔记|相关笔记]]
```

### A-mem field mapping / 与 A-mem 的字段映射

| A-mem field / 字段 | Obsidian mapping / 映射 |
| --- | --- |
| `id`, `content` | YAML `id` and Markdown body / YAML `id` 与 Markdown 正文 |
| `keywords`, `context`, `category`, `tags` | YAML frontmatter + body sections / YAML frontmatter + 正文小节 |
| `links` | YAML memory IDs + bidirectional `[[wikilink]]` / YAML 内存 ID + 双向 `[[wikilink]]` |
| `timestamp`, `last_accessed`, `retrieval_count` | YAML frontmatter |
| `evolution_history` | YAML evolution history / YAML 演化记录 |
| Chroma similarity search | Cosine similarity over embeddings persisted in `_amem-index.json` / `_amem-index.json` 中持久化 embedding 的余弦相似度检索 |

## Privacy and cost / 隐私与费用

- **English** — Source text and candidate note metadata are sent to your configured chat/embedding services. Do not process sensitive content until you confirm the provider's data policy.
- **中文** — 原始文本片段、候选 note 元数据会发送到你配置的聊天/embedding 服务；请勿在未确认供应商数据政策前处理敏感内容。
- **English** — API keys are stored in Obsidian plugin data, not the system keychain. Use restricted keys and avoid syncing `data.json` to untrusted locations.
- **中文** — API key 存在 Obsidian 插件数据中，而不是系统密钥链。请使用受限 key，并避免同步 `data.json` 到不可信位置。
- **English** — Long files can trigger multiple chat and embedding requests. Lower `Maximum notes per ingestion` or disable `Auto-link and A-mem evolution` to control cost.
- **中文** — 文章/长文件会产生多次聊天和 embedding 请求。可在设置中调低 `Maximum notes per ingestion` 或关闭 `Auto-link and A-mem evolution` 控制成本。

## Design boundaries / 设计边界

- **English** — This is a lightweight implementation: embeddings are stored in the vault and no local ChromaDB or `sentence-transformers` service is required.
- **中文** — 这是轻量实现：向量索引保存在 vault 中，未启动本地 ChromaDB 或 `sentence-transformers` 服务。
- **English** — Neighbor updates are conservative: only the LLM's explicit `update_neighbor` action writes back to existing notes.
- **中文** — A-mem 的邻居更新是可选且保守的：只有 LLM 明确选择 `update_neighbor` 时才写回旧 note。
- **English** — Test in a scratch vault first to review tags, links, and model output before processing a large corpus.
- **中文** — 建议先在测试 vault 试跑，检查标签词表、链接质量和模型输出后再处理大量资料。

## Development validation / 开发验证

**English** — The project is validated with:

**中文** — 本项目已通过：

```bash
npx tsc --noEmit
npm run build
```
