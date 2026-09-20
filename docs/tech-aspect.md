# Nexus — Technical Aspects & Data Flow

> High-depth engineering reference for the Nexus codebase.
> Companion to `README.md` and `docs/technical-deep-dive.md`.
> Code refs: `cmd/api/main.go`, `nexus-frontend/src/*`, `terraform/*`, `Dockerfile`.

---

## 1. What Nexus Is

Nexus is a **multi-model AI chat orchestrator**:

* One chat UI, five physical providers + two virtual modes.
* **Cross-Model Persistent Memory (CMPM):** full history is always sent; on model switch an AI-generated handoff brief is injected as a `system` message.
* **Semantic long-term memory (RAG):** every Q/A pair is embedded to 1536-d vectors and re-injected on relevant future prompts.
* **Streaming-first UX:** Server-Sent Events (SSE) token streaming with optimistic UI.
* **Smart routing:** latency + cost based auto-selection, failure cooldown, ensemble synthesis.

---

## 2. Tech Stack (pinned)

| Layer | Technology | Version / Detail | Role |
|---|---|---|---|
| Backend | Go `net/http` stdlib only | `go 1.25.11` (`go.mod`) | API server, adapters, router, DB, auth — single `cmd/api/main.go` (~1929 lines) |
| DB client (primary) | `github.com/jackc/pgx/v5` | `v5.10.0` + `pgxpool` | Supabase PostgreSQL + `pgvector` |
| DB client (fallback) | `modernc.org/sqlite` | `v1.56.0` (pure-Go, no CGO) | Local `nexus.db` when `SUPABASE_DB_URL` missing/unreachable |
| Env | `github.com/joho/godotenv` | `v1.5.1` | Loads root `.env` |
| Frontend | React + React DOM | `^19.2.7` | Chat state, SSE parsing, auth |
| Build | Vite + `@vitejs/plugin-react` | `vite ^8.1.1` | Dev server `:5173`, HMR, build |
| Supabase JS | `@supabase/supabase-js` | `^2.112.2` | `signUp/signInWithPassword/signOut/refreshSession/onAuthStateChange` |
| Markdown | `react-markdown` | `^10.1.0` | Assistant rendering + `MarkdownBoundary` error boundary |
| Motion / WebGL | `motion` + `ogl` | `^12.42.2` / `^1.0.11` | `BlurText.jsx`, `SideRays.jsx` background |
| Icons | `lucide-react` | `^1.31.0` | Provider icons, topbar, composer |
| Lint / reload | `oxlint` / `air` | `^1.71.0` / `1.66` | `npm run lint`, `.air.toml` Go hot-reload |
| Infra | Terraform AWS provider + community modules | EKS `~>20.31`, VPC `~>6.0`, K8s `1.30` | `terraform/*.tf` |
| Containers | Docker multi-stage | `golang:1.25.11-alpine` → `alpine:3.20` | `Dockerfile`, `deploy-nexus.sh` via GHCR |

Physical providers:

| Key | Model string in code | Endpoint | Notes |
|---|---|---|---|
| `groq` | `groq/compound` | `https://api.groq.com/openai/v1/chat/completions` | OpenAI-compat, ultra-fast. Also ensemble synthesizer. |
| `mistral` | `mistral-small-latest` | `https://api.mistral.ai/v1/chat/completions` | OpenAI-compat. |
| `chatgpt` | `gpt-4o-mini` | `https://api.openai.com/v1/chat/completions` | OpenAI-compat. Also `text-embedding-3-small` for embeddings. |
| `gemini` | `gemini-2.5-flash` | `.../v1beta/models/gemini-2.5-flash:generateContent` + `:streamGenerateContent?alt=sse` | Native Gemini shape, not OpenAI-compat. Embedding via `gemini-embedding-001`. |
| `deepseek` | `deepseek-ai/deepseek-v4-flash-0731` | `https://integrate.api.nvidia.com/v1/chat/completions` | OpenAI-compat via NVIDIA. 110s ctx timeout (slowest). |
| `ensemble` | — | fan-out `groq+mistral` | Virtual. Parallel + synthesis. |
| `auto` | — | `rankedProviders()` | Virtual. Excludes `chatgpt/deepseek` by design (cost). |

---

## 3. Repository Structure

```
Nexus/
├── cmd/api/main.go              # Entire backend: auth, embeddings, metrics,
│                                # adapters, ensemble, DB, 7 handlers, CORS, main()
├── nexus-frontend/
│   ├── src/App.jsx              # Chat UI, dual messages/history state, SSE client,
│   │                            # model-switch handoff, auth gate, sidebar/topbar
│   ├── src/HistoryPanel.jsx     # Data & Memory Hub: queries + RAG memories tabs
│   ├── src/AuthPage.jsx         # Signin/signup/forgot/update + guest mode landing
│   ├── src/AuthModal.jsx
│   ├── src/supabaseClient.js    # createClient + isSupabaseConfigured guard
│   ├── src/main.jsx             # StrictMode root
│   ├── src/BlurText.jsx         # Motion animated hero text
│   ├── src/SideRays.jsx         # OGL WebGL background
│   ├── src/BorderGlow.jsx       # Interactive composer glow
│   ├── vite.config.js           # react() only
│   └── .env                     # VITE_SUPABASE_URL/ANON_KEY/API_URL
├── docs/
│   ├── technical-deep-dive.md
│   ├── tech-aspect.md           # this file
│   ├── interview-qa.md, research-paper.md, nexus_upgrade_roadmap.md
├── terraform/
│   ├── eks.tf                   # EKS 1.30, managed node group, addons
│   ├── vpc.tf                   # community VPC 10.0.0.0/16, 3 AZs, NAT, ELB tags
│   ├── eks-addons.tf, variables.tf, versions.tf, outputs.tf
├── Dockerfile                   # CGO_ENABLED=0 build → alpine run, EXPOSE 8080
├── deploy-nexus.sh              # pull GHCR image → --env-file $HOME/Nexus/.env → -p 127.0.0.1:8080:8080
├── .air.toml                    # go build -o ./tmp/main ./cmd/api, watch go+env
├── .env                         # GROQ/MISTRAL/OPENAI/GEMINI/DEEPSEEK + SUPABASE_*
├── go.mod/go.sum
└── nexus.db                     # SQLite fallback artifact
```

---

## 4. Backend Deep Dive (`cmd/api/main.go`)

Monolith deliberately — no framework, explicit control over timeouts/streaming/auth.

### 4.1 Auth & context middleware (lines ~31-354)

* `type contextKey`, `userIDKey="user_id"`, `jwtHeader/jwtClaims/jwksKey/jwksDoc`.
* `authMiddleware(next)`:
  * No `Authorization` → `context.WithValue(ctx,"guest")` (guest mode works end-to-end).
  * `Bearer <token>` → `verifySupabaseJWT(token)` → `userID` in context. Invalid → `401 {error: invalid or expired token}` (fail-closed).
* `verifySupabaseJWT`:
  * Split `header.payload.sig`, parse `alg/kid`.
  * `ES256`: `verifyES256` → fetch JWKS from `SUPABASE_URL/auth/v1/.well-known/jwks.json` (8s timeout, `apikey` header), decode P-256 `x/y` → `ecdsa.Verify(sha256(signingInput))` → claims. On JWKS failure, fallback to `verifyViaSupabaseAPI` (`GET /auth/v1/user` with anon+user token) to tolerate rotation/propagation delay.
  * `HS256`: `verifyHS256` via HMAC-SHA256 with `SUPABASE_JWT_SECRET`/`JWT_SECRET`. Rejects if secret missing.
  * Else `unsupported alg`.
  * Expiry `exp+30s` grace. Rejects anon/service keys with no `sub/email`.
* `jwksCache` (RWMutex, 1h TTL, serve-stale on fetch error) avoids JWKS storm.

### 4.2 Embedding & Memory Engine / MaaS (lines ~356-733)

* `generateEmbedding(ctx,text)` cascade:
  1. OpenAI `text-embedding-3-small` `dimensions:1536` (10s timeout).
  2. Gemini `gemini-embedding-001` with `outputDimensionality:1536` (pad/truncate to 1536).
  3. `generateDeterministicEmbedding(text,1536)`: FNV-1a per lowercase word → index + sign → L2-normalize. Guarantees offline function.
* `cosineSimilarity`, `formatVectorForSQL("[f,f,...]")` for `::vector` casts.
* `saveMemory(userID,prompt,answer)` (async via `go saveMemory` from `saveQuery`): `content="User:{p}\nAssistant:{a}"` → embed (10s ctx) → Postgres `INSERT conversation_memories(user_id,content,embedding)` or SQLite `embedding JSON`.
* `retrieveRelevantMemories(ctx,userID,prompt,topK=3)`:
  * Postgres: `SELECT content ... WHERE user_id=$1 ORDER BY embedding <=> $2::vector LIMIT $3` (pgvector nearest neighbor).
  * SQLite: last 200 rows → `json.Unmarshal` each → `cosine>0.15` → bubble sort desc → topK. Portable but O(N) in Go.
* `injectMemoryRAGContext(ctx,userID,lastPrompt,history)`:
  * Returns `(newHistory, injected bool)`. Builds `Below is relevant past conversation memory... [1]... Use background...` system message. If history already has `system`, appends to it; else prepends. Preserves single-system invariant.
* `handleMemories`: `GET` last 50 memories, `DELETE` clear per user. Powers Memories tab.

### 4.3 Provider metrics / Smart Router (lines ~735-836)

* `providerCostPer1K`: groq 0.00059, mistral 0.002, chatgpt 0.006, gemini 0.00035, deepseek 0.00027.
* `providerMetrics{emaLatencyMs,callCount,errorCount,consecutiveErrors,lastErrorAt}` + Mutex. Seeded EMAs: groq 200, deepseek 250, chatgpt 300, gemini 350, mistral 400.
* `record(provider,latencyMs,failed)`: `EMA = 0.3*new + 0.7*old`; errors bump `consecutiveErrors` + `lastErrorAt`.
* `score = 0.6*min(latency/3000,1) + 0.4*min(cost/0.01,1)`; `Inf` if `inCooldownLocked` (`consecutiveErrors>0 && since<90s`). `snapshot()` exposes `ema_latency_ms,cost,calls,errors,in_cooldown,score` (`-1` = cooldown) via `GET /metrics`.

### 4.4 Provider adapters (lines ~838-1277)

* Shared shapes: `chatRequest{model,messages,stream}`, `message{role,content}`, `chatResponse`, `streamChunk{choices[].delta.content}`.
* `sendChatRequest(ctx,url,key,reqBody,provider)`: JSON marshal → 120s client → non-200 → `provider API error (status): body` → `choices[0].message.content`.
* `streamOpenAICompat(ctx,url,key,model,history,out chan string)`: `stream:true`, 120s client, `bufio.Scanner` (64KB→10MB buffer) → `data:` lines → skip `[DONE]` → `token → out`.
* Per-provider `callX(history)` (25s ctx, except deepseek 110s) + `streamX(ctx,history,out)` wrappers that also `pMetrics.record`.
* Gemini special: `geminiContent{role,parts[{text}]}`, `buildGeminiContents` maps `assistant→model`, **drops `system`** (v1beta limitation — handoff/RAG system context is lost on Gemini, known tradeoff). `callGemini` uses `:generateContent`, `streamGemini` uses `:streamGenerateContent?alt=sse` with its own chunk parser.
* Ensemble `callEnsemble(history)` (non-streaming): `WaitGroup(2)` → `callGroq || callMistral` in parallel → `rawAnswers map` → if both fail → error → else `synthesisPrompt="Here are answers... Combine..."` → `callGroq(synthesis)` → `(final, rawAnswers)`.

### 4.5 Router (lines ~1279-1360)

* `selectProvider(_ string) = rankedProviders()[0] || groq`.
* `rankedProviders()`: candidates `groq,mistral,gemini` (intentionally excludes `chatgpt` cost), partition into `ok` vs `cooled`, bubble-sort `ok` by score asc. If all cooled, return cooled list so caller surfaces real provider error.
* `callProvider(provider,history)`: switch dispatch incl. `ensemble`.

### 4.6 Database (lines ~1362-1474)

* `DBBackend{driver: postgres|sqlite, pgPool, sqlDB}`, global `activeDB`.
* `connectDB()`:
  1. If `SUPABASE_DB_URL`: `pgxpool.New` + `Ping` (5s) → `CREATE EXTENSION vector; CREATE TABLE queries/conversation_memories (+ ALTER ADD user_id)` → `activeDB=postgres`.
  2. Else/failure → `sql.Open(sqlite, nexus.db)` → `CREATE TABLE` equivalents (`embedding TEXT JSON`, `metadata TEXT`) → `activeDB=sqlite`. Server **still starts** if DB fails (stateless degraded mode).
* Schema:
  ```sql
  queries(id PK, user_id TEXT DEFAULT 'guest', prompt TEXT, provider TEXT, answer TEXT, created_at)
  conversation_memories(id PK, user_id TEXT, content TEXT, embedding vector(1536)|TEXT, metadata JSONB|TEXT, created_at)
  ```
* `saveQuery(userID,prompt,provider,answer)`: `INSERT queries` sync + `go saveMemory` async (fire-and-forget, 10s ctx inside).

### 4.7 HTTP handlers

* `handleQuery` (`POST /query`): only POST → decode `queryRequest{history,provider,prompt legacy}` → derive `lastPrompt` (last `user`) → `injectMemoryRAGContext` → `auto` ? try `rankedProviders()` in order with failover logging : `callProvider` once (unknown→400, else 500) → `saveQuery` → `{provider,answer,raw_answers}`.
* `handleStream` (`POST /stream`, SSE): headers `text/event-stream,no-cache,keep-alive,X-Accel-Buffering:no` + `Flusher` check → decode → resolve provider → `injectMemoryRAGContext` → emit `event:memory_rag` if injected + `event:provider` → `ensemble` branch (non-stream, emit full answer as one `data:` + `event:raw_answers` + `saveQuery` + `event:done`) else fan-out goroutine to `streamX` → multiplex `tokenCh/errCh/ctx.Done()` → per token `data: "<json-token>"\n\n` + accumulate `fullAnswer` → on close `saveQuery` + `event:done`. Errors → `event:error\ndata: "<escaped>"`.
* `handleSummarize` (`POST /summarize`): decode `{history,from_provider,to_provider}` → transcript `Role: content` → handoff prompt (3-5 sentences, topics/facts/next-steps, first-person, no switch mention) → call **to_provider** (default groq) → `{summary}`.
* `handleHistory` (`GET /history`): per-`userID` last 100 `queries ORDER BY created_at DESC`.
* `handleMemories`, `/metrics` (public snapshot), `/health` (`{status:ok,database:driver}`).
* `enableCORS`: `*`, `POST,GET,OPTIONS`, `Content-Type,Authorization,X-Requested-With`, short-circuit OPTIONS.
* `main()`: `godotenv.Load` → `PORT||8080` → `connectDB` (warn-only) → `ServeMux` → `http.Server{Read 35s, Write 120s (streaming), Idle 60s}` → `ListenAndServe`.

---

## 5. Frontend Deep Dive (`nexus-frontend/src`)

### 5.1 `App.jsx` (1165 lines — state machine)

* Dual arrays per conversation (display vs backend context):
  ```js
  makeConv() = {id:Date.now(), title:'New Chat', provider:'auto', messages:[], history:[], handoffs:[]}
  // messages: {role:user|assistant|error|handoff, text, provider, streaming, _id, rawAnswers, memoryAugmented}
  // history: [{role:user|assistant|system, content}]
  ```
* Global: `conversations[], currentId, prompt, attachments[], provider, loading, switchingModel, sidebarOpen, theme, session/user/authReady/isGuest/recoveryMode`.
* Persistence: `localStorage nexus-convs` (load lazy init, save on change), `nexus-theme`, `nexus-guest-mode`. No server-side conv table — history panel is flat query log, not resumable threads.
* `Composer` **module-level** (not nested) to avoid textarea remount / first-char bug. Auto-resize to 200px, file input (`image/*,.pdf,.doc,.docx,.txt,.csv,.json,.md`), attachment chips, `ModelSelector` + Send. `Enter` submits, `Shift+Enter` newline.
* `ModelSelector`: custom dropdown `auto,groq,mistral,chatgpt,gemini,deepseek,ensemble` with `PROVIDER_COLORS` + `MODEL_ICONS` (Sparkles/Zap/Wind/Bot/Gem/Brain/Layers), outside-click close.
* `handleProviderChange(newProvider)` (3-phase handoff): guard `messages>0 && changed` → optimistic `handoff` message → `POST /summarize` with `Authorization` if session → replace existing `system` (bounded growth) → mark `done`, push `handoffs[]`. Failure still switches provider without brief.
* `handleSubmit(e)` (SSE client): merge attachments as `📎 [Attached File:name]\n\ntext` (text-only, no binary upload) → optimistic user append + `title=slice(0,42)` → placeholder assistant `streaming:true` → `POST /stream` via `fetch+AbortController` → `reader.getReader()+TextDecoder` split on `\n`, track `currentEvent` (`provider|memory_rag|raw_answers|error|done|token`) → `JSON.parse(raw)` per token → append to `_id`-matched message. `provider` event corrects for `auto`; `memory_rag` sets `memoryAugmented` → `RAG Memory` badge. `done` appends to `history`. Network `TypeError` → `⚠️ Cannot reach backend (API_URL)` error message replacing placeholder.
* Shell: `SideRays` bg, mobile sidebar + backdrop, `sidebarOpen` default `innerWidth>=768`, topbar (History, Theme Light/Dark via `data-theme`, Contact dropdown, Docs link, profile avatar → SignOut), landing (`BlurText` greeting by time-of-day + email prefix, starter chips) vs chat mode (`ReactMarkdown` bubbles + `provider-tag`, `raw_answers<details>`, typing indicators, `bottomRef` autoscroll).
* Auth gate: `if (authReady && (!session||recoveryMode) && !isGuest) return <AuthPage .../>`. `supabase.auth.getSession + onAuthStateChange`, `PASSWORD_RECOVERY` handling, guest flag.

### 5.2 Supporting components

* `supabaseClient.js`: `VITE_SUPABASE_URL/ANON_KEY` → `isSupabaseConfigured`, placeholder fallback to avoid `createClient` throw.
* `HistoryPanel.jsx` (Data & Memory Hub): tabs `queries|memories` → `GET /history|/memories` with `Bearer`, `throwForStatus` preserving `{error}`, 401 → one `refreshSession()` retry → expired UI with Sign-in-again/Retry. Local search filter, `timeAgo`, expandable Markdown, `DELETE /memories` with confirm. `API_URL=VITE_API_URL||localhost:8080`.
* `AuthPage.jsx`: tabs `signin|signup|forgot|update`, recovery detection via `?code=`/`type=recovery` + `PASSWORD_RECOVERY` listener, `signInWithPassword/signUp/resetPasswordForEmail/updateUser`, guest button → `onGuestMode`.
* Visual: `SideRays.jsx` (OGL shader), `BlurText.jsx` (Motion word stagger), `BorderGlow.jsx` (mouse-tracking conic glow), `App.css/AuthModal.css/AuthPage.css/HistoryPanel.css` design tokens + light/dark via `data-theme`.

---

## 6. End-to-End Data Flows

### 6.1 Streaming chat (happy path)

```
User types → Composer → handleSubmit
  → state: messages+=[user], history+=[user], placeholder assistant(streaming)
  → POST :8080/stream {history:[...full], provider} + Bearer?
  → authMiddleware → guest|userID
  → lastPrompt = last user.content
  → retrieveRelevantMemories(userID,lastPrompt) → inject system? → event:memory_rag?
  → selectProvider if auto → event:provider (resolved)
  → streamX → provider SSE → tokenCh → backend data:"token" → frontend fullText+=token
  → event:done → history+=[assistant], streaming=false
  → saveQuery → INSERT queries + async INSERT memories (embed)
  → HistoryPanel /metrics reflect new row
```

Wire shape per token: `data: "hello"\n\n`; terminal: `event: done\ndata: {}\n\n`; error: `event: error\ndata: "msg"\n\n`.

### 6.2 Non-streaming `/query`

Same enrichment/routing/persistence, single JSON round-trip. Used by docs/clients; ensemble synthesis also non-stream internally.

### 6.3 Model-switch handoff

```
Dropdown groq→mistral → handleProviderChange
  → handoff msg "Switching..."
  → POST /summarize {history, from:groq, to:mistral}
  → backend transcript + handoff prompt → callMistral(synthesisHistory)
  → {summary} → history=[system:summary, ...old.filter(!system)]
  → UI "Switched to mistral. Context absorbed ✓"
  → next /stream includes system brief (+ RAG if relevant)
```

### 6.4 RAG memory loop

```
...after each answer: saveMemory embed(content) → pgvector/SQLite...
...next prompt: embed(lastPrompt) → top3 (pg <=> OR sqlite cosine>0.15)
  → system merge → provider sees long-term context → badge in UI
...inspect: HistoryPanel Memories tab → GET /memories → search/expand/clear (DELETE)
```

### 6.5 History & auth scoping

```
AuthPage signin → supabase-js session → access_token in memory (App session state)
 → all /query|/stream|/history|/memories|/summarize carry Bearer
 → backend userID → WHERE user_id=$1/? → per-user isolation
 → guest (no token) → user_id='guest' shared bucket
```

### 6.6 Auto + ensemble routing

```
auto → rankedProviders by 0.6*latency+0.4*cost, skip 90s-cooldown
     → /query: try each until success (Mistral 429 failover)
     → /stream: single pick (no mid-stream failover)
ensemble → parallel groq+mistral → raw_answers{} → groq synthesis → final + raws
metrics → GET /metrics drives debugging ("why auto chose X")
```

---

## 7. Configuration, Run, Deploy

Env (root `.env`): `GROQ_API_KEY, MISTRAL_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, SUPABASE_DB_URL, SUPABASE_URL, SUPABASE_ANON_KEY [, SUPABASE_JWT_SECRET/JWT_SECRET, PORT]`.
Frontend (`.env`): `VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_URL`.

```bash
# backend dev
air                          # .air.toml: go build -o ./tmp/main ./cmd/api
# or
go run ./cmd/api/main.go     # :8080
# frontend
cd nexus-frontend && npm install && npm run dev  # :5173
```

`Dockerfile`: `go mod download → CGO_ENABLED=0 GOOS=linux go build -p 1 -o /nexus ./cmd/api` → `alpine:3.20 + ca-certificates`, `EXPOSE 8080`, `ENTRYPOINT ./nexus`.
`deploy-nexus.sh`: `docker pull ghcr.io/.../nexus-backend:latest → rm → run -d --restart unless-stopped --env-file $HOME/Nexus/.env -p 127.0.0.1:8080:8080`.
Terraform (`us-east-1`, `nexus-eks`, `1.30`, `10.0.0.0/16`, `t3.medium 1-3/desired 2`): `vpc.tf` 3 AZs public/private + single NAT (cost) + ELB discovery tags; `eks.tf` managed node group ON_DEMAND + `coredns/kube-proxy/vpc-cni/ebs-csi`, `enable_cluster_creator_admin_permissions=true` (portfolio convenience, lock down in prod).

---

## 8. Cross-Cutting Concerns

* **Resilience:** DB-optional boot, embedding 3-tier fallback, JWKS stale-serve + API fallback, auto failover, SSE 120s write timeout, scanner 10MB cap, `MarkdownBoundary` prevents render crash.
* **Boundedness:** single `system` slot (replace not append), SQLite 200-row RAG window, history 100 / memories 50 limits, `io.LimitReader` on JWKS errors.
* **Security notes:** `*` CORS (dev convenience), EKS public endpoint, committed `.env` in repo snapshot contains live keys — rotate before public push; `user_id='guest'` bucket is shared, not isolated by IP.
* **Known tradeoffs:** Gemini drops `system` (handoff/RAG weakened there); SQLite RAG is O(N) + bubble sort; `/stream auto` no failover; attachments are filename notices, not file bytes; `localStorage` convs don't sync across devices (server has flat log, no threads API yet).

---

## 9. Where to Look Next

* Backend entry: `cmd/api/main.go:1879 main`, `1569 handleQuery`, `1651 handleStream`, `1502 handleSummarize`, `315 authMiddleware`, `629 injectMemoryRAGContext`, `1296 rankedProviders`, `1195 callEnsemble`.
* Frontend entry: `nexus-frontend/src/App.jsx:626 handleSubmit`, `:536 handleProviderChange`, `:56 STREAM_URL`, `HistoryPanel.jsx:122 fetchHistory`, `supabaseClient.js:9 isSupabaseConfigured`.
* Infra: `Dockerfile`, `deploy-nexus.sh`, `terraform/eks.tf`, `terraform/vpc.tf`, `.air.toml`.
