<div align="center">

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56" fill="none" width="96" height="96">
  <ellipse cx="28" cy="17" rx="7" ry="17" fill="#D97757" transform="rotate(0 28 28)"/>
  <ellipse cx="28" cy="17" rx="7" ry="17" fill="#E8A820" transform="rotate(120 28 28)"/>
  <ellipse cx="28" cy="17" rx="7" ry="17" fill="#6E8EF0" transform="rotate(240 28 28)"/>
  <circle cx="28" cy="28" r="4.5" fill="#F2F1EE"/>
</svg>

# Nexus

**Talk to any AI. Switch models anytime. Never lose context.**

[![Go](https://img.shields.io/badge/Go-1.25-00ADD8?style=flat-square&logo=go)](https://go.dev/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite)](https://vitejs.dev/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?style=flat-square&logo=supabase)](https://supabase.com/)

</div>

---

## What is Nexus?

Nexus is a **multi-model AI chat app** — one interface, four AI providers, with a twist: every model **remembers the full conversation**, and when you switch models mid-chat, the new model gets **automatically briefed** on what was discussed before.

No context lost. No repeating yourself.

---

## Use Cases

| Scenario | How Nexus Helps |
|----------|----------------|
| 🔍 **Research** | Start with Groq for fast answers, switch to Gemini for deeper analysis — context carries over |
| 💻 **Coding** | Debug with ChatGPT, then switch to Mistral for a second opinion on the same code |
| ✍️ **Writing** | Draft ideas with one model, refine with another without re-explaining the topic |
| ⚡ **Speed vs Depth** | Use Groq (ultra-fast) for quick Q&A, Mistral for longer analytical prompts |
| 🎯 **Cross-validation** | Use **Ensemble mode** — query Groq & Mistral in parallel and get a synthesized best answer |

---

## How Cross-Model Persistent Memory Works

This is the core feature. Here's what happens step by step:

### 1 — Normal chat (single model)

Every message you send includes the **full conversation history**, not just the latest message. The model always knows what was said before.

```
You:  "My project is called Nexus"
AI:   "Got it! What would you like to know about Nexus?"

You:  "What's my project called?"       ← sends full history
AI:   "Your project is called Nexus."   ← remembers ✓
```

### 2 — Switching models mid-chat

When you change the model from the dropdown, three things happen automatically:

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  Step 1 — You switch Groq → Mistral                     │
│           ↓                                             │
│  Step 2 — Nexus sends the full chat history to          │
│           /summarize and asks Mistral to write          │
│           a briefing about the conversation             │
│           ↓                                             │
│  Step 3 — That briefing is silently injected            │
│           into every future request as context          │
│           ↓                                             │
│  Mistral now knows everything Groq knew  ✓              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

What the UI shows:

```
● Groq ─────── Switched to mistral. Context absorbed ✓ ─────── ●
```

### 3 — What the handoff brief looks like

The new model writes its own briefing in first-person:

> *"The user and I were discussing building a REST API in Go using the Chi framework. They prefer Chi over Gin and we were about to start writing the router. No unresolved questions so far."*

This means the new model's briefing sounds natural and idiomatic — not a mechanical copy-paste.

---

## Providers

| Model | Key | Speed | Best for |
|-------|-----|-------|---------|
| 🟠 **Groq** (Llama 3.3 70B) | `groq` | ⚡ Ultra-fast | Quick Q&A, coding help |
| 🔵 **Mistral Small** | `mistral` | Fast | Analysis, longer prompts |
| 🟢 **ChatGPT** (GPT-4o mini) | `chatgpt` | Medium | Reliable all-rounder |
| 🟡 **Gemini 2.5 Flash** | `gemini` | Fast | Google-native tasks |
| 🟣 **Ensemble** | `ensemble` | Parallel | Cross-validated answers |
| ⚪ **Auto** | `auto` | — | Nexus picks for you |

---

## Directory Structure

```
Nexus/
│
├── 📁 cmd/
│   └── 📁 api/
│       └── main.go          ← Go backend: all AI adapters, API routes, DB
│
├── 📁 nexus-frontend/
│   ├── 📁 src/
│   │   ├── App.jsx          ← Chat UI, memory logic, model-switch handoff
│   │   ├── App.css          ← All styles & design tokens
│   │   ├── BlurText.jsx     ← Animated hero text
│   │   ├── SideRays.jsx     ← WebGL background effect (OGL)
│   │   └── BorderGlow.jsx   ← Interactive composer glow
│   ├── index.html
│   └── package.json
│
├── 📁 docs/
│   └── technical-deep-dive.md  ← Full API reference, architecture, future scope
│
├── .env                     ← Your API keys (never commit)
├── .air.toml                ← Hot-reload config for Go
├── go.mod
├── Dockerfile
└── README.md
```

---

## Quick Start

**1. Add your API keys to `.env`:**
```env
GROQ_API_KEY=gsk_...
MISTRAL_API_KEY=...
OPENAI_API_KEY=sk-proj-...
GEMINI_API_KEY=...
SUPABASE_DB_URL=postgresql://...  # Optional: falls back to local SQLite (nexus.db) if unreachable
```

**2. Start the Go backend:**
```bash
air                          # with hot-reload
# or
go run ./cmd/api/main.go
```

**3. Start the frontend:**
```bash
cd nexus-frontend
npm install
npm run dev
```

Open **http://localhost:5173** and start chatting.

---

## API Endpoints

| Method | Path | What it does |
|--------|------|-------------|
| `POST` | `/query` | Send a message (with full history) to an AI |
| `POST` | `/summarize` | Generate a handoff brief when switching models |
| `GET` | `/history` | Fetch the last 100 saved queries from Supabase |
| `GET` | `/health` | Health check |

---

## Want the full technical details?

→ See [`docs/technical-deep-dive.md`](docs/technical-deep-dive.md) for the complete API reference, architecture diagrams, ensemble mode internals, and the full future roadmap.

---

<div align="center">

**Gaourav Patil** · [patilgaourav304@gmail.com](mailto:patilgaourav304@gmail.com) · +91 98348 92067

*Built with Go · React · Supabase*

</div>
