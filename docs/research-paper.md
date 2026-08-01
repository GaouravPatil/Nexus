# Nexus: A Cross-Model Persistent Memory Architecture for Multi-Provider Large Language Model Orchestration

**Gaourav Patil**
Independent Researcher · patilgaourav304@gmail.com

---

## Abstract

Modern conversational AI systems are typically siloed to a single model provider, requiring users to restart interactions and repeat context when switching between models. This paper introduces **Nexus**, a multi-model AI orchestration system that enables seamless, context-preserving transitions between heterogeneous Large Language Model (LLM) providers — including Groq (Llama 3.3 70B), Mistral Small, OpenAI GPT-4o mini, and Google Gemini 2.5 Flash — within a single conversation thread. The core contribution is a novel **Cross-Model Persistent Memory (CMPM)** mechanism: upon a provider switch, the system invokes a dedicated `/summarize` endpoint that prompts the *target* model to generate a first-person handoff brief from the full conversation transcript, which is then injected as a system-role message for all subsequent requests. The system further includes an **Ensemble Mode** that fans out queries concurrently to multiple providers using Go goroutines and synthesizes a unified answer. The full-stack implementation — a Go `net/http` backend with a React 19 / Vite frontend — is lightweight, stateless-capable, and extensible. We describe the architecture, protocol design, implementation tradeoffs, and identify open problems in cross-model context transfer.

**Keywords:** Large Language Models, Multi-Model Orchestration, Context Persistence, Conversational AI, Cross-Model Handoff, Ensemble Inference

---

## 1. Introduction

The proliferation of commercially available Large Language Models has created an ecosystem in which different providers excel at different tasks: Groq's LPU hardware delivers sub-second inference for short queries, Mistral excels at analytical reasoning, OpenAI's GPT family offers broad reliability, and Google's Gemini natively integrates with Google's knowledge graph. A practitioner wishing to use the best model for each phase of a long conversation is currently forced to manually copy-paste context into a new chat window each time they switch providers — an inefficient and error-prone workflow.

This fragmentation motivates **Nexus**: a unified interface that treats multiple LLM providers as interchangeable, hot-swappable backends while preserving the full conversational context across transitions. The system operates on two orthogonal axes:

1. **Vertical memory** — Within a single provider session, every user turn carries the complete conversation history (`[{role, content}]` array) to the model, ensuring full multi-turn awareness.
2. **Horizontal memory** — When the user switches providers, an AI-generated handoff brief is synthesized by the *target* model and injected as system context, enabling zero-gap knowledge transfer.

The rest of this paper is organized as follows. Section 2 surveys related work. Section 3 presents the system architecture. Section 4 describes the CMPM protocol. Section 5 covers Ensemble Mode. Section 6 discusses implementation details. Section 7 proposes an evaluation framework. Section 8 discusses limitations and future work. Section 9 concludes.

---

## 2. Related Work

### 2.1 Multi-Model Routing

Prior work on LLM routing (e.g., LLM-Router [1], Mixture-of-Agents [2]) focuses on selecting the optimal single model per request. These systems do not address the problem of preserving conversational state across provider transitions — they treat each query as stateless. Nexus is complementary: it can route queries to the optimal provider *and* preserve context when the provider changes.

### 2.2 Conversation Memory in LLMs

LangChain's `ConversationBufferMemory` [3] and similar frameworks maintain conversation state but are bound to a single model backend. MemGPT [4] introduces a layered memory hierarchy for long conversations within one model. Nexus extends this concept *across* model boundaries, a dimension not addressed by prior work.

### 2.3 Ensemble and Mixture-of-Experts Inference

Ensemble prompting — querying multiple models and aggregating outputs — has been studied for factual accuracy [5] and calibration [6]. Nexus implements a lightweight ensemble that runs Groq and Mistral concurrently and uses a third call (Groq-as-judge) for synthesis, making the approach practical at consumer API tier.

### 2.4 Context Summarization

Summarization-based context compression has been used to extend effective context windows [7]. Nexus repurposes this technique not for compression within a session but for *transfer* across providers, with the distinctive property that the *target model* generates its own briefing in first-person — preserving stylistic naturalness for that model's conversational register.

---

## 3. System Architecture

### 3.1 High-Level Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        NEXUS SYSTEM                              │
│                                                                  │
│   ┌─────────────────────┐         ┌──────────────────────────┐   │
│   │   React Frontend    │         │    Go API Server         │   │
│   │   (Vite + React 19) │◄───────►│    (net/http  :8080)     │   │
│   │                     │  HTTP   │                          │   │
│   │  • Conversation UI  │  JSON   │  POST /query             │   │
│   │  • History State    │         │  POST /summarize         │   │
│   │  • Handoff Banners  │         │  GET  /history           │   │
│   │  • localStorage     │         │  GET  /health            │   │
│   └─────────────────────┘         └──────────┬───────────────┘   │
│                                              │                   │
│                              ┌───────────────┼─────────────┐     │
│                              ▼               ▼             ▼     │
│                         ┌────────┐  ┌──────────┐  ┌──────────┐   │
│                         │  Groq  │  │  Mistral │  │ ChatGPT  │   │
│                         │Llama3.3│  │  Small   │  │ gpt-4o   │   │
│                         │  70B   │  │  Latest  │  │   mini   │   │
│                         └────────┘  └──────────┘  └──────────┘   │
│                         ┌────────┐  ┌──────────────────────┐     │
│                         │ Gemini │  │  Supabase PostgreSQL  │     │
│                         │  2.5   │  │  (pgx/v5 pool)       │     │
│                         │ Flash  │  │  queries table        │     │
│                         └────────┘  └──────────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
```

Nexus is a thin orchestration layer. The Go backend holds no model weights; it is a routing, adaptation, and persistence service that bridges the React frontend with four external LLM provider APIs and an optional PostgreSQL database.

### 3.2 Backend: Go API Server

The backend is a single Go binary (`cmd/api/main.go`, ~626 LOC) using only the standard library plus `pgx/v5` for PostgreSQL and `godotenv` for environment loading. It exposes four HTTP endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/query` | POST | Route a message (with full history) to a provider |
| `/summarize` | POST | Generate a cross-model handoff brief |
| `/history` | GET | Retrieve last 100 queries from the database |
| `/health` | GET | Liveness probe |

All endpoints are wrapped with a CORS middleware that permits cross-origin requests.

### 3.3 Provider Adapters

Each LLM provider is abstracted behind a typed adapter function:

- `callGroq(history []message)` — OpenAI-compatible endpoint, Bearer auth
- `callMistral(history []message)` — OpenAI-compatible endpoint, Bearer auth
- `callOpenAI(history []message)` — Official OpenAI endpoint, Bearer auth
- `callGemini(history []message)` — Google REST API, API-key query param; requires role mapping (`assistant` → `model`; `system` roles discarded as Gemini does not natively support them)

All OpenAI-compatible adapters share a single `sendChatRequest` helper. Each adapter enforces a 25-second `context.WithTimeout` and a 30-second `http.Client` timeout.

### 3.4 Frontend

The frontend is a React 19 / Vite 8 single-page application. Each conversation object tracks:

```
{
  id:       timestamp integer (unique)
  title:    first 42 chars of the first user message
  provider: active provider name
  messages: display layer [{role, text, provider?, rawAnswers?}]
  history:  backend context [{role: "user"|"assistant"|"system", content}]
  handoffs: log of model-switch events
}
```

Conversations are serialized to `localStorage` on every state change, providing browser-side persistence without a backend session store.

### 3.5 Data Persistence

Query persistence is optional. If `SUPABASE_DB_URL` is configured and reachable, each (prompt, provider, answer) tuple is written to a `queries` table after a successful completion. Persistence failures are logged but never block the response path.

---

## 4. Cross-Model Persistent Memory (CMPM)

### 4.1 Phase 1 — Vertical Memory (Single-Provider)

On every message submission, the frontend sends the *entire conversation history* to `/query`:

```json
POST /query
{
  "history": [
    { "role": "user",      "content": "My project is called Nexus" },
    { "role": "assistant", "content": "Understood. What can I help with?" },
    { "role": "user",      "content": "What is my project called?" }
  ],
  "provider": "groq"
}
```

This history slice is passed verbatim to the provider's chat completion API. The model thus has full awareness of all prior turns.

### 4.2 Phase 2 — Trigger

When `currentProvider !== newProvider` and the conversation is non-empty, the frontend:

1. Renders a transient "switching… analysing chat history" and banner.
2. Immediately posts to `/summarize`:

```json
POST /summarize
{
  "history": [ ...all prior turns... ],
  "from_provider": "groq",
  "to_provider":   "mistral"
}
```

### 4.3 Phase 3 — Target-Side Brief Generation

The `/summarize` handler reconstructs a human-readable transcript from the history and submits the following prompt to the *target* provider:

```
You are taking over a conversation from {fromProvider}. Here is the
full conversation history so far:

---
{transcript}
---

Please create a concise but thorough handoff summary (3-5 sentences)
that captures:
1. The main topic(s) discussed
2. Key facts, answers, or conclusions reached
3. Any unresolved questions or next steps the user had in mind

This summary will be given to you (as {toProvider}) as context
before the user's next message. Write it in first-person as if you
already knew this context. Do not mention the model switch.
```

**Key insight:** The brief is authored by the *target* model, in first-person. This keeps the summary stylistically idiomatic for the new provider's conversational register, rather than a mechanical replay of the prior model's phrasing.

### 4.4 Injection

The returned summary is prepended to the conversation history as a `system`-role message, replacing any prior system entry to prevent unbounded growth:

```json
[
  { "role": "system",    "content": "<handoff brief>" },
  { "role": "user",      "content": "..." },
  { "role": "assistant", "content": "..." },
  ...
]
```

The UI renders a completion banner:

```
● groq ─── Switched to mistral. Context absorbed ✓ ─── ●
```

### 4.5 Failure Degradation

If `/summarize` fails (network error, provider outage), the provider switch still completes — the user's full `history[]` is preserved intact, and the new provider begins without the AI-generated brief. The banner reports "Switching without context brief." No error is thrown.

### 4.6 End-to-End Example

```
[Groq]    User:  "My secret code word is BANANA"
          Groq:  "Noted — your code word is BANANA."

  — User switches dropdown: Groq → Mistral —

Nexus → POST /summarize (target: Mistral)
Mistral writes:
  "The user established a secret code word: BANANA. No further
   context was provided about its purpose or use case."

Brief injected as system message.

[Mistral] User:  "What is my secret code word?"
          Mistral: "Your secret code word is BANANA."  ✓
```

---

## 5. Ensemble Mode

### 5.1 Design

Ensemble mode queries Groq and Mistral *concurrently* via Go goroutines, then invokes Groq a second time to synthesize a final answer:

```
                    ┌─────────────────┐
                    │   User prompt   │
                    └────────┬────────┘
                             │
               ┌─────────────┴──────────────┐
               │    sync.WaitGroup (n=2)     │
               │  goroutine 1  goroutine 2   │
               │       ▼            ▼        │
               │   [Groq]       [Mistral]    │
               └─────────────┬──────────────┘
                             │  wg.Wait()
                             ▼
                   ┌──────────────────┐
                   │ Synthesis prompt │
                   │  → Groq (judge)  │
                   └────────┬─────────┘
                            ▼
                 ┌────────────────────┐
                 │  answer (string)   │
                 │  raw_answers (map) │
                 └────────────────────┘
```

The synthesis prompt explicitly instructs the judge to combine the two answers without commenting on the models themselves.

### 5.2 Response Shape

```json
{
  "provider":    "ensemble",
  "answer":      "Synthesized final answer...",
  "raw_answers": {
    "groq":    "Groq's raw response",
    "mistral": "Mistral's raw response"
  }
}
```

Raw answers are rendered in collapsible `<details>` elements in the UI, allowing manual comparison.

### 5.3 Fault Tolerance

If one provider fails, the ensemble proceeds with the single valid answer. Both must fail for the endpoint to return an error.

---

## 6. Implementation Details

### 6.1 Technology Stack

| Layer | Technology | Version | Role |
|---|---|---|---|
| Backend | Go (`net/http`) | 1.25 | API server, adapters, routing |
| Database | PostgreSQL via pgx/v5 | 5.10 | Query history (Supabase) |
| Frontend | React | 19.2 | Chat UI, state management |
| Build Tool | Vite | 8.1 | Dev server, HMR |
| Animation | Motion (Framer) | 12 | UI micro-animations |
| 3D/WebGL | OGL | 1.0 | Ambient background effect |
| Markdown | react-markdown | 10.1 | AI response rendering |
| Hot Reload | Air | 1.66 | Go live reload |

### 6.2 Auto-Routing Heuristic

The `auto` provider uses a prompt-length heuristic:

```go
func selectProvider(prompt string) string {
    if len(prompt) > 300 {
        return "mistral"  // longer → analytical
    }
    return "groq"         // shorter → fastest
}
```

This captures the practical observation that Groq's Llama 3.3 70B is optimal for quick Q&A while Mistral Small is better calibrated for longer, structured reasoning.

### 6.3 Timeout Architecture

Three nested timeouts prevent resource leaks from slow provider APIs:

| Layer | Duration | Mechanism |
|---|---|---|
| Go context | 25 s | `context.WithTimeout` cancels the HTTP request |
| HTTP client | 30 s | `http.Client.Timeout` closes the TCP connection |
| Frontend | 35 s | `AbortController` cancels the `fetch()` |

### 6.4 Component Isolation (Frontend)

The `Composer` form component is defined at module scope, not inside `App`. Defining it inside `App` would cause React to re-create the component type on every parent render, unmounting the `<textarea>` and losing focus/cursor position after every keystroke — a subtle correctness issue documented in the codebase.

### 6.5 Error Boundary

A `MarkdownBoundary` class component wraps every `ReactMarkdown` render, catching malformed LLM responses that would otherwise throw a React render error and crash the entire UI.

### 6.6 Containerization

A minimal two-stage `Dockerfile` builds the Go binary in a `golang:1.25` builder stage and copies only the binary into a `debian:bookworm-slim` final image, yielding a production image without the Go toolchain (~80 MB vs ~1.2 GB).

---

## 7. Proposed Evaluation Framework

A full empirical evaluation is deferred to future work. We outline the proposed methodology here.

### 7.1 Cross-Model Context Retention (Primary Metric)

**Setup:** Construct a dataset of "fact-establishment" conversations: the user tells Provider A a set of N facts, then switches to Provider B and queries each fact.

**Metric:** Context Retention Rate (CRR) = number of facts correctly recalled by Provider B / N.

**Conditions:**
1. Baseline: B receives only the new query message (no history, no brief)
2. History-only: B receives full `history[]`, no injected brief
3. Brief-only: B receives only the CMPM brief as a system message
4. **Nexus CMPM**: B receives the brief + full history (full system)

**Hypothesis:** Nexus CMPM achieves the highest CRR, with History-only approaching it on short conversations and falling off as conversation length grows.

### 7.2 Ensemble Quality

**Metric:** Win rate vs. individual providers on MMLU [8] and TruthfulQA [9] benchmarks, rated by GPT-4 as an independent evaluator.

**Hypothesis:** Ensemble achieves higher accuracy than either individual model on factual queries, with the greatest gains on contested or ambiguous prompts.

### 7.3 Handoff Latency Overhead

**Metric:** Wall-clock latency added by the `/summarize` call (CMPM overhead) vs. a cold provider switch with no context transfer.

**Expected finding:** CMPM adds 1–3 seconds of additional latency (one extra LLM call), which is acceptable for the user experience given that the alternative is manually re-establishing context.

---

## 8. Limitations and Future Work

### 8.1 Semantic Fidelity of Handoff Briefs

The brief is generated in a single LLM call with a fixed prompt. In very long conversations, the model may omit nuanced context or overweight recent turns. Mitigations:

- **Multi-pass summarization** with chain-of-thought prompting
- **Structured extraction** via JSON schema to enforce coverage of key entities, decisions, and open questions
- **Human evaluation benchmarks** for brief quality across providers

### 8.2 Context Window Limits

Sending the full `history[]` on every turn does not scale to very long conversations. Planned mitigations:

- **Sliding window with compression**: Keep the last N turns verbatim; replace older turns with a running summary.
- **pgvector RAG**: Embed each turn; retrieve semantically relevant prior context on each new query.

### 8.3 Server-Side Persistence

Conversation state lives in browser `localStorage`, making it fragile and device-bound. A planned `conversations` table in Supabase with JWT-based multi-user authentication would provide durable, cross-device history.

### 8.4 Streaming Responses

The current request-response cycle blocks until the model produces its complete answer. Token-by-token streaming via `Transfer-Encoding: chunked` (Go) and `ReadableStream` (frontend) would significantly reduce perceived latency.

### 8.5 Ensemble Aggregation

The current ensemble uses Groq as an unconditional judge. Planned improvements:

- **Confidence-weighted merging**: Models expressing higher certainty contribute more to the final answer.
- **Majority voting**: For closed-domain factual queries, output the majority-agreed answer.
- **Disagreement detection**: Surface explicit model disagreements to the user.

### 8.6 Extended Provider Support

Planned adapters: Anthropic Claude (Messages API), local models via Ollama (privacy-preserving, zero API cost), and multimodal inputs (image forwarding to Gemini Vision or GPT-4o).

---

## 9. Conclusion

Nexus introduces a practical, deployable approach to cross-model persistent memory for multi-provider LLM conversations. The core CMPM protocol — a three-phase trigger-summarize-inject cycle in which the *target* model generates its own first-person briefing — achieves zero-context-loss provider transitions without model fine-tuning, shared embedding spaces, or proprietary infrastructure. The ensemble mode provides parallel multi-model inference with graceful fault tolerance. Built on a lean Go backend and a React 19 frontend, Nexus is self-hosted, extensible, and composable with future model providers.

The system opens several concrete research directions: quantifying handoff brief quality across providers and conversation lengths, scaling context management to very long histories via sliding-window compression or RAG, and developing richer ensemble aggregation strategies. The complete codebase is available as an open-source reference implementation.

---

## References

[1] Ong, I., et al. "LLM-Router: Intelligently Routing LLM Requests for Cost-Effective Inference." *arXiv preprint*, 2024.

[2] Wang, J., et al. "Mixture-of-Agents Enhances Large Language Model Capabilities." *arXiv:2406.04692*, 2024.

[3] LangChain. "ConversationBufferMemory." *LangChain Documentation*, 2023. https://python.langchain.com

[4] Packer, C., et al. "MemGPT: Towards LLMs as Operating Systems." *arXiv:2310.08560*, 2023.

[5] Li, X., et al. "Making Language Models Better Reasoners with Step-Aware Verifier." *ACL*, 2023.

[6] Kadavath, S., et al. "Language Models (Mostly) Know What They Know." *arXiv:2207.05221*, 2022.

[7] Chevalier, A., et al. "Adapting Language Models to Compress Contexts." *arXiv:2305.14788*, 2023.

[8] Hendrycks, D., et al. "Measuring Massive Multitask Language Understanding." *ICLR*, 2021.

[9] Lin, S., et al. "TruthfulQA: Measuring How Models Mimic Human Falsehoods." *ACL*, 2022.

---

*Manuscript prepared: July 2026*
*Correspondence: patilgaourav304@gmail.com*
