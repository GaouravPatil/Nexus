<div align="center">

<img src="nexus-frontend/public/vite.svg" width="64" alt="Nexus Logo" />

# Nexus

**Cross-model persistent AI chat with seamless model switching and zero context loss**

[![Go](https://img.shields.io/badge/Go-1.25-00ADD8?style=flat-square&logo=go)](https://go.dev/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite)](https://vitejs.dev/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?style=flat-square&logo=supabase)](https://supabase.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

</div>

---

## What is Nexus?

Nexus is a multi-model AI orchestrator that lets you chat with **Groq (Llama 3.3 70B)**, **Mistral**, **ChatGPT (GPT-4o mini)**, and **Google Gemini 2.5 Flash** — all from a single interface. The key capability that sets Nexus apart is **cross-model persistent memory**: every model has full knowledge of the conversation history, and when you switch models mid-chat, the new model receives an AI-generated **context handoff brief** so there is zero gap in understanding.

```
User → "My code word is BANANA"    [Groq responds]
User → switches to Mistral
       ↳ Nexus generates handoff: "The user shared a code word: BANANA"
User → "What is my code word?"     [Mistral answers: BANANA ✓]
```

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Cross-Model Persistent Memory — How It Works](#cross-model-persistent-memory--how-it-works)
  - [Single-Model Memory Flow](#single-model-memory-flow)
  - [Cross-Model Handoff Flow](#cross-model-handoff-flow)
  - [The Summarize Endpoint](#the-summarize-endpoint)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Providers & Routing](#providers--routing)
- [Ensemble Mode](#ensemble-mode)
- [Future Scope](#future-scope)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        NEXUS SYSTEM                             │
│                                                                 │
│   ┌─────────────────────┐          ┌─────────────────────────┐  │
│   │   React Frontend    │          │     Go API Server       │  │
│   │   (Vite + React 19) │◄────────►│     (net/http :8080)    │  │
│   │                     │  HTTP    │                         │  │
│   │  • Conversation UI  │  JSON    │  POST /query            │  │
│   │  • History State    │          │  POST /summarize        │  │
│   │  • Handoff Banners  │          │  GET  /history          │  │
│   │  • localStorage     │          │  GET  /health           │  │
│   └─────────────────────┘          └────────┬────────────────┘  │
│                                             │                   │
│                              ┌──────────────┼──────────────┐    │
│                              ▼              ▼              ▼    │
│                         ┌────────┐   ┌─────────┐  ┌──────────┐  │
│                         │  Groq  │   │ Mistral │  │ ChatGPT  │  │
│                         │Llama3.3│   │ Small   │  │ gpt-4o   │  │
│                         │  70B   │   │ Latest  │  │   mini   │  │
│                         └────────┘   └─────────┘  └──────────┘  │
│                              │                                   │
│                         ┌────────┐   ┌──────────────────────┐   │
│                         │ Gemini │   │      Supabase        │   │
│                         │  2.5   │   │  PostgreSQL (pgx/v5) │   │
│                         │ Flash  │   │  query history table │   │
│                         └────────┘   └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Cross-Model Persistent Memory — How It Works

### Single-Model Memory Flow

Each conversation maintains two parallel arrays:

| Array | Purpose | Lives In |
|-------|---------|----------|
| `messages[]` | Display layer — what the user sees in the chat UI | React state + `localStorage` |
| `history[]` | Backend context — OpenAI-style `[{role, content}]` array sent to the API | React state + `localStorage` |

On every message submission, the **full conversation history** is sent to the backend:

```
POST /query
{
  "history": [
    { "role": "user",      "content": "My name is Alex" },
    { "role": "assistant", "content": "Hello Alex!" },
    { "role": "user",      "content": "What is my name?" }   ← new message
  ],
  "provider": "groq"
}
```

The Go backend forwards the entire `history` slice to the provider's API. Every provider (Groq, Mistral, OpenAI) natively supports multi-turn conversation via their messages array. The model therefore has the full context of every prior exchange.

```
┌──────────────────────────────────────────────────────────────────┐
│  SINGLE-MODEL MEMORY FLOW                                        │
│                                                                  │
│   Turn 1        Turn 2        Turn 3                             │
│   ┌───────┐     ┌───────┐     ┌───────┐                          │
│   │ User  │     │ User  │     │ User  │                          │
│   │  msg  │     │  msg  │     │  msg  │                          │
│   └───┬───┘     └───┬───┘     └───┬───┘                          │
│       │             │             │                              │
│       ▼             ▼             ▼                              │
│   ┌───────────────────────────────────────┐                      │
│   │          history[] sent to API        │                      │
│   │  [U1]   [U1,A1,U2]   [U1,A1,U2,A2,U3]│                      │
│   └───────────────────┬───────────────────┘                      │
│                       │                                          │
│                       ▼                                          │
│                  ┌─────────┐                                     │
│                  │  Model  │  Has full context ✓                  │
│                  └─────────┘                                     │
└──────────────────────────────────────────────────────────────────┘
```

### Cross-Model Handoff Flow

When a user changes the provider dropdown mid-conversation, Nexus triggers a **3-phase handoff**:

```
┌──────────────────────────────────────────────────────────────────────┐
│  CROSS-MODEL HANDOFF FLOW                                            │
│                                                                      │
│  Phase 1: TRIGGER                                                    │
│  ┌────────────────────────────────┐                                  │
│  │  User changes dropdown         │                                  │
│  │  Groq  ──────────►  Mistral   │                                  │
│  └────────────────┬───────────────┘                                  │
│                   │                                                  │
│                   ▼                                                  │
│  Phase 2: SUMMARIZE                                                  │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Frontend sends full history to POST /summarize               │  │
│  │                                                                │  │
│  │  {                                                             │  │
│  │    "history": [ ...all prior turns... ],                       │  │
│  │    "from_provider": "groq",                                    │  │
│  │    "to_provider":   "mistral"                                  │  │
│  │  }                                                             │  │
│  │                                                                │  │
│  │  Go backend asks Mistral to read the transcript and write      │  │
│  │  a first-person handoff brief (3-5 sentences):                 │  │
│  │                                                                │  │
│  │  "The user and I discussed building a REST API in Go using     │  │
│  │   the Chi framework. The user prefers Chi over Gin. We were    │  │
│  │   about to start writing the router..."                        │  │
│  └────────────────┬───────────────────────────────────────────────┘  │
│                   │                                                  │
│                   ▼                                                  │
│  Phase 3: INJECT & CONTINUE                                          │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  The brief is injected as a system message at the TOP of       │  │
│  │  the conversation history for all future requests:             │  │
│  │                                                                │  │
│  │  history = [                                                   │  │
│  │    { role: "system",    content: "<handoff brief>" },  ← NEW  │  │
│  │    { role: "user",      content: "..." },                      │  │
│  │    { role: "assistant", content: "..." },                      │  │
│  │    ...                                                         │  │
│  │  ]                                                             │  │
│  │                                                                │  │
│  │  UI shows:  ● Groq ──── Switched to mistral. Context           │  │
│  │                         absorbed ✓ ──── ●                     │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  All subsequent messages go to Mistral with full context ✓           │
└──────────────────────────────────────────────────────────────────────┘
```

### The Summarize Endpoint

`POST /summarize` is the engine of the cross-model handoff. Here is the exact prompt strategy:

```
You are taking over a conversation from {fromProvider}. Here is the full
conversation history so far:

---
User: {message1}
Assistant: {reply1}
...
---

Please create a concise but thorough handoff summary (3-5 sentences) that captures:
1. The main topic(s) discussed
2. Key facts, answers, or conclusions reached
3. Any unresolved questions or next steps the user had in mind

This summary will be given to you (as {toProvider}) as context before the user's
next message. Write it in first-person as if you already knew this context.
Do not mention the model switch.
```

The summary is generated **by the target model** — so Mistral writes its own briefing about what was discussed, making it feel natural and idiomatic for that model's personality.

---

## Tech Stack

| Layer | Technology | Version | Role |
|-------|-----------|---------|------|
| **Backend** | Go (`net/http`) | 1.25 | API server, model adapters, routing |
| **Database** | PostgreSQL via pgx/v5 | 5.10 | Query history persistence (Supabase) |
| **Frontend** | React | 19.2 | Chat UI, state management |
| **Build Tool** | Vite | 8.1 | Dev server, HMR, bundling |
| **Animation** | Motion (Framer) | 12 | UI micro-animations |
| **3D/WebGL** | OGL | 1.0 | SideRays background effect |
| **Markdown** | react-markdown | 10.1 | AI response rendering |
| **Hot Reload** | Air | 1.66 | Go live reload in development |
| **Linter** | oxlint | 1.71 | Fast JS/TS linting |

---

## Project Structure

```
Nexus/
├── cmd/
│   └── api/
│       └── main.go          # Entire Go backend (adapters, router, DB, handlers)
│
├── nexus-frontend/
│   ├── src/
│   │   ├── App.jsx          # Main React component (chat logic, memory, handoffs)
│   │   ├── App.css          # Design system & all component styles
│   │   ├── BlurText.jsx     # Animated hero text component
│   │   ├── SideRays.jsx     # WebGL background rays (OGL)
│   │   └── BorderGlow.jsx   # Interactive border glow on the composer
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
│
├── .env                     # API keys (never commit this)
├── .air.toml                # Air hot-reload config
├── go.mod
├── go.sum
├── Dockerfile
└── README.md
```

---

## API Reference

### `POST /query`

Send a message to an AI provider. Accepts the full conversation history for multi-turn memory.

**Request body:**
```json
{
  "history": [
    { "role": "user",      "content": "My name is Alex" },
    { "role": "assistant", "content": "Hello Alex!" },
    { "role": "user",      "content": "What is my name?" }
  ],
  "provider": "groq"
}
```

> **Legacy support:** The `"prompt"` string field is also accepted as a fallback for single-turn requests.

**Providers:** `groq` | `mistral` | `chatgpt` | `gemini` | `ensemble` | `auto`

**Response:**
```json
{
  "provider": "groq",
  "answer": "Your name is Alex.",
  "raw_answers": null
}
```

In `ensemble` mode, `raw_answers` contains individual model outputs:
```json
{
  "provider": "ensemble",
  "answer": "Synthesized combined answer...",
  "raw_answers": {
    "groq":    "Groq's raw answer",
    "mistral": "Mistral's raw answer"
  }
}
```

---

### `POST /summarize`

Generate a context handoff brief when switching models. Called automatically by the frontend.

**Request body:**
```json
{
  "history": [
    { "role": "user",      "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "from_provider": "groq",
  "to_provider":   "mistral"
}
```

**Response:**
```json
{
  "summary": "I'm taking over a conversation where the user asked about..."
}
```

---

### `GET /history`

Returns the last 100 queries stored in Supabase.

**Response:**
```json
[
  {
    "id": 42,
    "prompt": "What is Go?",
    "provider": "groq",
    "answer": "Go is a compiled language...",
    "created_at": "2026-07-29T18:00:00Z"
  }
]
```

---

### `GET /health`

```json
{ "status": "ok" }
```

---

## Getting Started

### Prerequisites

- [Go 1.25+](https://go.dev/dl/)
- [Node.js 20+](https://nodejs.org/)
- [Air](https://github.com/air-verse/air) for Go hot-reload: `go install github.com/air-verse/air@latest`
- A [Supabase](https://supabase.com) project with a `queries` table (or skip for stateless mode)

### 1. Clone & configure

```bash
git clone https://github.com/GaouravPatil/Nexus.git
cd Nexus
cp .env.example .env   # then fill in your API keys
```

### 2. Create the Supabase table

```sql
create table queries (
  id         bigserial primary key,
  prompt     text        not null,
  provider   text        not null,
  answer     text        not null,
  created_at timestamptz not null default now()
);
```

### 3. Start the backend

```bash
# With hot-reload (recommended for development)
air

# Or plain Go
go run ./cmd/api/main.go
```

The API will start on `http://localhost:8080`.

### 4. Start the frontend

```bash
cd nexus-frontend
npm install
npm run dev
```

The UI will start on `http://localhost:5173`.

---

## Environment Variables

Create a `.env` file in the project root:

```env
# Required — at least one AI provider key is needed
GROQ_API_KEY=gsk_...
MISTRAL_API_KEY=...
OPENAI_API_KEY=sk-proj-...
GEMINI_API_KEY=...

# Optional — skip for stateless mode (history won't persist)
SUPABASE_DB_URL=postgresql://...

# Optional — default is 8080
PORT=8080
```

> The server starts even if the DB is unreachable. Queries still work; they just aren't persisted.

---

## Providers & Routing

| Provider key | Model | Notes |
|---|---|---|
| `groq` | `llama-3.3-70b-versatile` | Fastest. Best for quick Q&A |
| `mistral` | `mistral-small-latest` | Good for longer, analytical prompts |
| `chatgpt` | `gpt-4o-mini` | Reliable, well-rounded |
| `gemini` | `gemini-2.5-flash` | Google's latest flash model |
| `ensemble` | Groq + Mistral | Parallel query + synthesis |
| `auto` | Groq (short) / Mistral (long) | Routes based on prompt length |

**`auto` routing logic** (in `selectProvider`):

```go
func selectProvider(prompt string) string {
    if len(prompt) > 300 {
        return "mistral"   // longer prompts → Mistral
    }
    return "groq"          // short prompts → Groq (faster)
}
```

---

## Ensemble Mode

Ensemble mode runs **Groq and Mistral in parallel** using Go goroutines, then asks Groq to synthesize a single best answer from both responses.

```
                    ┌─────────────────┐
                    │   User prompt   │
                    └────────┬────────┘
                             │
               ┌─────────────┴──────────────┐
               │  Go: sync.WaitGroup (2)     │
               │  goroutine 1  goroutine 2   │
               │       │            │        │
               ▼       ▼            ▼        │
          ┌─────────┐  ┌─────────┐           │
          │  Groq   │  │ Mistral │           │
          └────┬────┘  └────┬────┘           │
               │            │       wg.Wait()│
               └────────────┘               │
                      │                     │
                      ▼                     │
            ┌──────────────────┐            │
            │  Synthesis prompt│            │
            │  → Groq (judge)  │            │
            └────────┬─────────┘            │
                     │                      │
                     ▼                      │
          ┌────────────────────┐            │
          │  Final answer      │            │
          │  + raw_answers map │◄───────────┘
          └────────────────────┘
```

The UI lets you expand each raw provider answer via `<details>` to compare responses side-by-side.

---

## Future Scope

### 🧠 Memory & Persistence

| Feature | Description | Priority |
|---------|-------------|----------|
| **Server-side conversation storage** | Move from `localStorage` to Supabase `conversations` table with user sessions. History survives device changes and browser clears. | High |
| **Conversation vector embeddings** | Embed each conversation in pgvector. On every new message, retrieve semantically relevant prior turns (RAG over your own chat history). Solves context window limits for very long chats. | High |
| **Sliding window + compression** | For very long histories, compress older turns with a summary while keeping recent turns verbatim. | Medium |
| **Per-message metadata** | Track token counts, latency, and model version for each message. | Low |

### 🤖 Model Capabilities

| Feature | Description | Priority |
|---------|-------------|----------|
| **Streaming responses** | Use `Transfer-Encoding: chunked` on the Go side + `ReadableStream` on the frontend to stream tokens as they arrive instead of waiting for the full response. | High |
| **Anthropic Claude** | Add `callClaude()` adapter using the Anthropic Messages API. | Medium |
| **Tool / function calling** | Expose tools (web search, code execution, calculator) via the OpenAI-compatible `tools` field. Route tool-capable prompts to providers that support it. | Medium |
| **Image input (multimodal)** | Accept image uploads in the composer; forward them to Gemini or GPT-4o vision endpoints. | Medium |
| **Local models via Ollama** | Add an Ollama adapter for `llama3`, `mistral`, and `deepseek-r1` running locally — zero API cost, full privacy. | Low |

### ⚙️ Backend & Infrastructure

| Feature | Description | Priority |
|---------|-------------|----------|
| **User authentication** | Add JWT-based auth (or Supabase Auth) so multiple users can have isolated conversation histories. | High |
| **Rate limiting** | Per-IP request rate limiting on the Go server using a token bucket to prevent API key abuse. | High |
| **Request caching** | Cache identical (prompt + provider) pairs in Redis for a short TTL to avoid redundant API calls. | Medium |
| **Cost tracking** | Estimate and log token costs per query based on provider pricing. Surface total cost in the UI. | Medium |
| **Docker Compose** | Single `docker compose up` to start Go API + Vite frontend + Postgres locally. | Low |
| **WebSocket support** | Replace polling with a persistent WebSocket connection for real-time streaming. | Low |

### 🎨 Frontend & UX

| Feature | Description | Priority |
|---------|-------------|----------|
| **Code syntax highlighting** | Integrate `react-syntax-highlighter` or `shiki` for rendered code blocks. | High |
| **Conversation search** | Full-text search across all saved conversations in the sidebar. | Medium |
| **Export to Markdown/PDF** | One-click export of the current conversation. | Medium |
| **Keyboard shortcut palette** | `Cmd+K` command palette for quick actions (new chat, switch provider, search). | Low |
| **Mobile-responsive layout** | Sidebar collapses to a drawer on small screens. | Low |
| **Theme system** | Light mode + custom accent color picker. | Low |

### 🔬 AI Quality

| Feature | Description | Priority |
|---------|-------------|----------|
| **Smart auto-routing** | Replace the simple length heuristic with a lightweight classifier that routes based on task type (code → Groq, analysis → Mistral, creative → ChatGPT). | Medium |
| **Ensemble voting** | Instead of Groq synthesising ensemble answers, use a majority-vote or confidence-weighted merge. | Low |
| **Prompt templates** | Pre-built system prompts for roles: "Senior Engineer", "Rubber Duck", "Explain like I'm 5". | Low |

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit your changes: `git commit -m "feat: add streaming support"`
4. Push and open a Pull Request

---

## Author

**Gaourav Patil**
- ✉️ [patilgaourav304@gmail.com](mailto:patilgaourav304@gmail.com)
- 📞 +91 98348 92067

---

<div align="center">

Built with Go · React · Supabase · ♥

</div>
