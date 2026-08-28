# Auto-Zettelkasten for Obsidian

把对话、Obsidian vault 内的文件、剪贴板文本和网页文章转换成一组可复用的原子笔记（atomic notes），并按 [A-MEM: Agentic Memory for LLM Agents](https://github.com/agiresearch/A-mem) 的思路进行标签、检索、关联和轻量演化。

> 这是一个 **Obsidian 社区插件项目**，不是 A-mem Python 仓库的封装。它把 A-mem 的 `MemoryNote` 元数据、近邻检索和 `strengthen` / `update_neighbor` 演化流程映射到 Obsidian Markdown、YAML frontmatter 和 wikilinks。

## 已实现功能

- **输入入口**
  - 当前文件或文件资源管理器右键菜单中的 vault 文件（Markdown、TXT、HTML、JSON、CSV）
  - 编辑器选中文本
  - 剪贴板文本：适合直接复制聊天记录
  - 网页文章 URL：通过 Obsidian `requestUrl` 获取页面并抽取常见正文区域
- **A-mem 风格 note 生成**
  - 将较长内容按段落分块，并要求 LLM 产出多个独立、可检索的 atomic notes
  - 每条 note 都含有 `content`、`keywords`、`context`、`category`、`tags`、时间戳、检索次数、链接和演化历史
  - 标签至少结合主题/领域、来源格式和 note 类型；可复用你已有的 vault frontmatter tags 与自定义标签词表
- **轻量 A-mem 演化**
  - 对新 note 和既有 note 调用 OpenAI-compatible embeddings
  - 取 Top-K 近邻后，让 LLM 作出与 A-mem 对齐的 `strengthen` / `update_neighbor` 决策
  - 建立双向 `[[wikilink]]`，更新旧 note 的 `links`、`retrieval_count` 和 `evolution_history`
  - 可选更新旧 note 的 `context` / `tags`
- 自动维护 `A-mem/_A-mem MOC.md`
- 在 `A-mem/.amem-index.json` 中保存轻量检索索引和向量，避免每次都重新向量化所有 note。

## 安装

### 1. 构建

在本项目目录执行：

```bash
npm install
npm run build
```

### 2. 安装到你的 vault

创建目标目录：

```text
<你的 Obsidian vault>/.obsidian/plugins/amem-obsidian/
```

将以下构建产物复制到该目录：

```text
main.js
manifest.json
styles.css
```

然后在 Obsidian 中：

1. **Settings → Community plugins**。
2. 如有需要先关闭 Restricted mode。
3. 刷新社区插件列表并启用 **A-mem Notes**。

开发时，可以把此项目目录直接链接或复制到上述插件目录；每次修改后运行 `npm run build`，然后在 Obsidian 中重新加载插件。

## 配置模型

打开 **Settings → A-mem Notes**，填写：

| 配置项 | 说明 |
| --- | --- |
| `OpenAI-compatible base URL` | 聊天模型服务的根 URL，通常以 `/v1` 结尾。插件请求 `POST /chat/completions`。 |
| `API key` | 聊天模型 API key。建议使用可限制额度/权限的 key。 |
| `Chat model` | 能稳定返回 JSON 的对话模型。 |
| `Embedding model` | 用于近邻检索的 embedding 模型。 |
| `Embedding base URL / API key` | 可选。如果聊天供应商没有 `/embeddings`，可单独填另一个 OpenAI-compatible embedding 服务；留空则复用聊天 URL 与 key。 |

聊天和 embedding API 可以分开：例如用支持 `/chat/completions` 的模型生成笔记，再使用另一个兼容 `/embeddings` 的服务建立关联。

如果 embedding 调用失败，插件仍会生成带标签的笔记，并降级为关键词相似度；自动关联效果会较弱。

## 使用方法

### 对话

1. 从任意聊天工具复制对话内容。
2. 在 Obsidian 命令面板执行 **A-mem: Ingest clipboard text as A-mem notes**。
3. 或者将对话导出为 Markdown/JSON 放入 vault，再对该文件执行 **A-mem: Ingest current file as A-mem notes**。

> Obsidian 插件无法直接读取外部网页/桌面应用（包括 DSH GUI）的当前对话状态；剪贴板和聊天导出文件是当前的一键入口。若需要从 DSH 当前对话直接导出，需要另做一个 DSH client-plugin + 本地写入桥接服务。

### 文件与文章

- 打开 vault 中的文本文件，运行 **A-mem: Ingest current file as A-mem notes**。
- 或在文件资源管理器中右键文件，选择 **Create A-mem notes from this file**。
- 选中一段内容，运行 **A-mem: Ingest selected text as A-mem notes**。
- 运行 **A-mem: Ingest web article URL as A-mem notes** 并输入文章 URL。

当前直接支持 Markdown、TXT、HTML、JSON、CSV。PDF 需先用 OCR/文本提取器转换为 Markdown 或纯文本；动态渲染且正文不在初始 HTML 中的网站也可能需要先保存正文。

## 输出结构

默认写入 vault 的 `A-mem/` 目录：

```text
A-mem/
├── 20250308-1530-example-note-a1b2c3.md
├── 20250308-1531-another-note-d4e5f6.md
├── _A-mem MOC.md
└── .amem-index.json
```

每条生成笔记类似：

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

字段与原始 A-mem `MemoryNote` 的对应关系：

| A-mem 字段 | Obsidian 映射 |
| --- | --- |
| `id`, `content` | YAML `id` 与 Markdown 正文 |
| `keywords`, `context`, `category`, `tags` | YAML frontmatter + 正文小节 |
| `links` | YAML 内存 ID + 双向 `[[wikilink]]` |
| `timestamp`, `last_accessed`, `retrieval_count` | YAML frontmatter |
| `evolution_history` | YAML 演化记录 |
| Chroma 相似检索 | `.amem-index.json` 中持久化 embedding 的余弦相似度检索 |

## 隐私与费用

- 原始文本片段、候选 note 元数据会发送到你配置的聊天/embedding 服务；请勿在未确认供应商数据政策前处理敏感内容。
- API key 存在 Obsidian 插件数据中，而不是系统密钥链。请使用受限 key，并避免同步 `.obsidian/plugins/amem-obsidian/data.json` 到不可信位置。
- 文章/长文件会产生多次聊天和 embedding 请求。可在设置中调低“Maximum notes per ingestion”或关闭“Auto-link and A-mem evolution”控制成本。

## 设计边界

- 这是轻量实现：向量索引保存在 vault 中，未启动本地 ChromaDB 或 `sentence-transformers` 服务。
- A-mem 的邻居更新是可选且保守的：只有 LLM 明确选择 `update_neighbor` 时才写回旧 note。
- 建议先在测试 vault 试跑，检查标签词表、链接质量和模型输出后再处理大量资料。

## 开发验证

本项目已通过：

```bash
npx tsc --noEmit
npm run build
```
