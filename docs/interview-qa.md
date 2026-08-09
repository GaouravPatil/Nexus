# Nexus — Interview Q&A Preparation

---

## 🟦 SECTION 1: Project Overview

**Q: What is Nexus?**
A: Nexus is a multi-model AI chat platform that lets users switch between AI providers — Groq, Mistral, OpenAI (ChatGPT), and Google Gemini — mid-conversation without losing context. Its core innovation is a cross-model persistent memory system: when you switch models, the new model receives a summarized brief of the existing conversation so it can continue seamlessly.

**Q: What problem does Nexus solve?**
A: Normally, every AI chat tool locks you into one model. If you switch models, the new one has no idea what you were discussing. Nexus solves this by generating an AI-powered context handoff brief so the new model is immediately aware of the full conversation history.

**Q: What is the tech stack?**
A:
- **Backend:** Go (Golang) — single-file HTTP server
- **Frontend:** React 19 + Vite
- **Database:** Supabase (managed PostgreSQL)
- **Infrastructure:** AWS EKS (Kubernetes) via Terraform
- **Containerization:** Docker (multi-stage build)
- **AI Providers:** Groq, Mistral, OpenAI, Google Gemini

---

## 🟦 SECTION 2: Backend (Go)

**Q: Why did you choose Go for the backend?**
A: Go is excellent for network-heavy services. It has built-in concurrency with goroutines, a very fast HTTP server in its standard library, and compiles to a tiny static binary — perfect for Docker. The ensemble feature (calling two APIs in parallel) was trivially easy to implement with `sync.WaitGroup` and goroutines.

**Q: How does the streaming work?**
A: The frontend calls `POST /stream`. The Go server sets `Content-Type: text/event-stream` headers (SSE — Server-Sent Events) and then streams tokens from the AI provider to the browser as they arrive. Each token is sent as `data: <json-token>\n\n`. The frontend reads this with the Fetch API's `ReadableStream` and appends each token to the message, creating the real-time typing effect.

**Q: What is SSE and why use it over WebSockets?**
A: SSE (Server-Sent Events) is a one-way persistent HTTP connection — server pushes data to the client. WebSockets are bidirectional. For AI streaming, we only need server→client, so SSE is simpler: it works over plain HTTP, doesn't need a protocol upgrade, and is natively supported by browsers. No extra library needed.

**Q: How does the Ensemble mode work?**
A: When the user selects "Ensemble", the Go backend launches two goroutines simultaneously — one calls Groq, one calls Mistral — using `sync.WaitGroup` to wait for both. Once both responses arrive, it sends both answers to Groq again with a synthesis prompt: "combine these two answers into one best final answer." The synthesized result is returned to the user.

**Q: How does the cross-model handoff (summarize) work?**
A: When the user switches providers mid-chat, the frontend calls `POST /summarize` with the full conversation history and the `from_provider` / `to_provider` values. The Go server builds a prompt asking the *new* model to summarize the conversation as a first-person context brief. This summary is then injected as a `system` message into the conversation history before the next user prompt, so the new model has full context.

**Q: Why is the entire backend in one file?**
A: For a project of this size (4 provider adapters, 4 HTTP endpoints), a single file is perfectly readable and avoids over-engineering. In a production team setting, I would split it into packages: `handlers/`, `providers/`, `db/`.

**Q: How do you handle CORS?**
A: A middleware wrapper `enableCORS()` sets `Access-Control-Allow-Origin: *` and handles `OPTIONS` preflight requests. Every route is wrapped with it. This is needed because the React dev server runs on port 5173 and the Go server runs on port 8080 — different origins.

**Q: How is the database used?**
A: Every query-response pair is saved to a Supabase PostgreSQL table (`queries`) via `pgx` — Go's PostgreSQL driver. The `saveQuery()` function is called after every successful AI response. This creates a server-side persistent log of all conversations independent of browser localStorage.

**Q: What happens if the database is unavailable?**
A: The server logs a warning but continues running. `saveQuery()` has a nil-check on `dbPool` and silently returns if no connection exists. The app degrades gracefully — chat still works, queries just aren't persisted to the DB.

**Q: How does the auto provider routing work?**
A: `selectProvider()` checks the prompt length. If it's over 300 characters, it routes to Mistral (good for longer context); otherwise Groq (ultra-fast for short prompts). This is a simple heuristic. In a real system, you'd consider cost, model capabilities, and latency metrics.

---

## 🟦 SECTION 3: Frontend (React)

**Q: Why is the Composer component defined outside the App function?**
A: If you define a component *inside* another component's function body, React creates a brand new component type on every render. This causes the previous component to unmount and a fresh one to mount — so the `<textarea>` loses focus and state after every keystroke. Defining `Composer` at module level ensures React sees it as a stable component type and only re-renders it, never unmounts it.

**Q: How does persistent conversation storage work on the frontend?**
A: `useState` is initialized by reading from `localStorage`. A `useEffect` watches the `conversations` array and writes it back to `localStorage` on every change. This means all chats survive browser refreshes. Each conversation object holds its full message list, OpenAI-format history array, provider, and handoff log.

**Q: What is the OpenAI-format history array and why keep two arrays?**
A: The `messages` array is for the UI — it includes display roles like `handoff`, `error`, etc., and UI metadata like `streaming: true`. The `history` array is strictly `[{role: "user"|"assistant"|"system", content: "..."}]` — the format all AI APIs expect. Two separate arrays prevent UI display logic from leaking into API calls.

**Q: How does real-time token rendering work in React?**
A: When the user submits, a placeholder assistant message is added with `streaming: true`. As each SSE token arrives, `updateConv()` maps over the messages array and appends the token to the matching message (`m._id === streamingMsgId`). React efficiently re-renders only the changed message. When the `done` event arrives, `streaming: false` is set and the blinking cursor disappears.

**Q: What is the MarkdownBoundary and why is it needed?**
A: It's a React Error Boundary (class component) that wraps `ReactMarkdown`. AI responses can sometimes contain malformed markdown that causes the renderer to throw. Without the boundary, a single bad response would crash the entire React tree (white screen). The boundary catches the error and displays `[render error]` instead.

**Q: What is the SideRays component doing technically?**
A: It uses the OGL WebGL library to compile and run a GLSL fragment shader on the GPU. The shader computes animated light ray brightness per pixel using trigonometric functions and a `iTime` uniform that increments each animation frame. An `IntersectionObserver` pauses the animation when the element is off-screen to save GPU resources.

**Q: What is the BorderGlow component?**
A: It tracks the mouse cursor position relative to the card's center using `onPointerMove`. It calculates two values — `edge-proximity` (how close the cursor is to the border, 0–1) and `cursor-angle` (direction in degrees). These are set as CSS custom properties, and the CSS uses a `conic-gradient` keyed on those values to render a glowing arc that follows the cursor around the card edge.

**Q: Why did you use Vite instead of Create React App?**
A: Vite uses native ES modules and `esbuild` for dev serving — it starts instantly and HMR (Hot Module Replacement) updates in milliseconds. CRA uses Webpack which can take 30+ seconds to cold-start on large projects. Vite is the modern standard for React projects.

---

## 🟦 SECTION 4: Infrastructure & DevOps

**Q: Walk me through the Dockerfile.**
A: It's a multi-stage build. Stage 1 uses `golang:alpine` as the builder — it downloads dependencies and compiles the Go binary. Stage 2 starts fresh from `alpine:3.20` (a ~5MB Linux image) and only copies the compiled binary in. The final image has no Go toolchain, no source code — just the binary and CA certificates. This keeps the image ~10MB vs ~800MB.

**Q: Why use multi-stage Docker builds?**
A: Security and size. You don't want your production container to have a compiler, source code, or dev tools. The smaller the image, the smaller the attack surface, the faster the pull, and the less storage cost.

**Q: What is Terraform and why did you use it?**
A: Terraform is Infrastructure as Code (IaC) — you describe your cloud infrastructure in `.tf` files and Terraform provisions it for you. I used it to create the AWS VPC, EKS cluster, and node groups. Benefits: version-controlled infrastructure, reproducible deployments, and you can tear down and recreate everything with one command.

**Q: Explain the AWS infrastructure you set up.**
A: 
- **VPC** (`vpc.tf`): Virtual Private Cloud with public subnets (for the load balancer) and private subnets (for EKS worker nodes) spread across 3 Availability Zones. A NAT Gateway allows private nodes to reach the internet.
- **EKS** (`eks.tf`): Amazon Elastic Kubernetes Service cluster. Managed node groups run EC2 instances as Kubernetes workers that run the Docker container.
- **EKS Add-ons** (`eks-addons.tf`): CoreDNS (DNS), kube-proxy (networking), VPC-CNI (pod networking), AWS Load Balancer Controller (expose services via ALB).

**Q: Why put EKS worker nodes in private subnets?**
A: Security. Worker nodes shouldn't be directly reachable from the internet. Only the Application Load Balancer in the public subnet accepts inbound traffic and routes it to the private nodes. This is a standard AWS security pattern.

**Q: What is `.air.toml`?**
A: Configuration for `air` — a Go hot-reload tool. When any `.go` file changes, air automatically re-runs `go build` and restarts the server. This is the Go equivalent of Vite's HMR for development.

**Q: What is `go.mod` / `go.sum`?**
A: `go.mod` defines the module name and lists direct dependencies (`pgx` for Postgres, `godotenv` for `.env` loading). `go.sum` contains cryptographic checksums of every dependency version — Go verifies these on download to prevent supply-chain attacks.

---

## 🟦 SECTION 5: System Design & Architecture

**Q: How does data flow from user input to AI response?**
A:
1. User types and presses Enter → React calls `POST /stream` with conversation history + provider
2. Go server receives it, picks the right provider function
3. Go opens a streaming HTTP connection to the AI provider (e.g., Groq)
4. AI provider sends tokens back to Go as SSE
5. Go immediately re-emits each token to the browser as SSE (`data: <token>\n\n`)
6. React appends each token to the streaming message → types out in real time
7. On `done` event, Go saves the full response to Supabase

**Q: How does cross-model memory work end-to-end?**
A:
1. User switches provider dropdown → React's `handleProviderChange()` fires
2. React shows "Switching from Groq → Mistral… analysing" in chat
3. React POSTs to `/summarize` with full history + from/to provider
4. Go builds a summarization prompt → calls the *new* model to summarize
5. Summary returned to frontend as JSON
6. React injects summary as a `system` message at the top of `history`
7. Next user message goes to the new model with the system brief prepended
8. New model responds with full context → "Context absorbed ✓" shown

**Q: What are the limitations of your current design?**
A:
- Single Go file — would need refactoring for a team
- No authentication — anyone with the URL can use it
- `selectProvider("auto")` is a simple length heuristic, not smart routing
- Ensemble mode is non-streaming (waits for both models to finish)
- Gemini streaming is faked (falls back to non-streaming due to API limitations)
- No rate limiting on the Go server

**Q: How would you scale this in production?**
A:
- Backend: Multiple Go pods in Kubernetes with horizontal autoscaling
- Add Redis for rate limiting and session caching
- Add an API Gateway (Kong or AWS API GW) for auth, throttling, logging
- Replace localStorage with a proper user account DB (Postgres + auth)
- Use a message queue (Kafka/SQS) for ensemble fan-out at scale
- Add observability: Prometheus metrics, Grafana dashboards, structured logging

**Q: Why Supabase instead of a self-hosted database?**
A: Supabase gives a managed PostgreSQL instance with a free tier, automatic backups, and a REST/realtime API out of the box. For a portfolio project, it removes the ops overhead of running your own Postgres. In a real production system at scale, I'd evaluate cost vs. control and potentially migrate to RDS or self-hosted Postgres on Kubernetes.

---

## 🟦 SECTION 6: Tricky / Deep Questions

**Q: What caused the "only types one character" bug and how did you fix it?**
A: The `Composer` component (the chat input) was defined *inside* the `App` function. In React, when a component type is defined inline, every parent re-render creates a new component class. React sees a different component type → unmounts the old one → mounts a fresh one. Since every keystroke triggers a state update → re-render, the textarea unmounted after every keypress. Fix: move `Composer` to module scope outside `App`.

**Q: Why use `_id` on streaming messages instead of array index?**
A: Array indices shift when items are added/removed. If you reference a message by index and another message is inserted before it, you'd update the wrong message. Stable unique IDs (`Date.now()` as `_id`) ensure you always update the exact right message regardless of array mutations.

**Q: How do you prevent the Gemini history from crashing?**
A: Gemini's API doesn't accept a `system` role — it only supports `user` and `model` (not `assistant`). In `callGemini()`, the code filters out `system` messages and remaps `assistant` → `model` before sending to the Gemini API. This silent transformation prevents a 400 error from Gemini.

**Q: What is `X-Accel-Buffering: no` in the stream handler?**
A: If the Go server is behind an Nginx reverse proxy (common in production), Nginx buffers responses by default. For SSE streaming, buffering breaks everything — Nginx would hold all tokens and release them at once when the response finishes. `X-Accel-Buffering: no` tells Nginx to disable buffering for this response and pass tokens through immediately.

**Q: Why does `streamGemini` fall back to non-streaming?**
A: Gemini's v1beta API for streaming (`streamGenerateContent`) requires a different endpoint and response format that isn't OpenAI-compatible. Rather than writing a full custom streaming parser, `streamGemini` calls the regular `callGemini()` and emits the full response as a single token on the channel. The UI still shows it as a "stream" — it just arrives all at once.

**Q: Why does the history array filter out duplicate system messages?**
A: On every model switch, a new `system` brief is generated. If you just appended it, the history would grow with multiple system messages — potentially confusing the model and wasting tokens. The code does `c.history.filter((h) => h.role !== 'system')` before prepending the new brief, ensuring there's always at most one system message.

---

## 🟦 SECTION 7: Behavioural / Project Questions

**Q: What was the hardest part of building Nexus?**
A: The cross-model handoff system. Getting the summarization prompt right so the new model genuinely absorbs context (not just repeats it), and managing the async flow — showing the "switching" UI, waiting for the summary API, injecting it correctly without race conditions — required careful state management.

**Q: What would you add next?**
A: User authentication (Supabase Auth), so conversations are tied to accounts not just browser storage. Then I'd add proper streaming for Gemini, an intelligent provider router that considers cost and latency, and a history panel pulling from the database — so you can recover chats on any device.

**Q: What did you learn from this project?**
A: How SSE streaming works at the HTTP level. How to manage complex async UI state in React without Redux. How Terraform + EKS work together for real Kubernetes deployments on AWS. And the importance of defining React components at the right scope — the textarea bug taught me exactly how React's reconciler decides what to mount vs. re-render.

**Q: Why didn't you use a framework like Express or FastAPI for the backend?**
A: Go's `net/http` standard library is production-ready and handles everything this project needs. Adding a framework would introduce dependencies without meaningful benefit at this scale. It also shows understanding of fundamentals rather than relying on abstractions.
