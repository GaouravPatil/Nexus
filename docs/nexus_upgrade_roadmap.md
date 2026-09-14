# Nexus Architectural Upgrade Roadmap

This document outlines the step-by-step implementation plan for upgrading **Nexus** with:
1. **Dedicated Authentication & Authorization Landing Page**
2. **Backend Auth & JWT Token Verification**
3. **Memory as a Service (MaaS) & Vector Database Architecture**

---

## 1. Phase 1: Authentication & Authorization Upgrade

### A. Frontend Changes (`nexus-frontend/`)
- [x] **Dedicated Auth / Landing View (`AuthPage.jsx`)**:
  - Replace the popup modal (`AuthModal.jsx`) with a full-screen landing page before entering the main chat workspace.
  - **Features**:
    - **Hero Section**: Highlight Nexus's core capabilities (Multi-model synthesis, Auto-routing, SSE streaming).
    - **Auth Form**: Toggle between **Sign In** and **Sign Up** using Supabase Auth (`supabase.auth.signInWithPassword` & `signUp`).
    - **Guest Mode ("Try as Guest")**: Allow visitors to test Nexus with standard guest rate limits without creating an account.
  - **State Management**: Persist user session (`user`, `session`, `access_token`) and handle smooth transitions to the main chat workspace upon authentication.

- [x] **Pass Bearer Token in API Requests**:
  - Update `fetch` calls in `App.jsx` (`/query`, `/stream`, `/history`, `/summarize`) to include the user's Supabase JWT access token in headers:
    ```javascript
    headers: {
      'Content-Type': 'application/json',
      'Authorization': session ? `Bearer ${session.access_token}` : ''
    }
    ```

---

### B. Backend Changes (`cmd/api/main.go`)
- [x] **Database Schema Update**:
  - Add `user_id` column to the `queries` table in both PostgreSQL and SQLite:
    ```sql
    ALTER TABLE queries ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT 'guest';
    ```
- [x] **JWT Auth Middleware (`authMiddleware`)**:
  - Intercept incoming HTTP requests to validate the `Authorization: Bearer <JWT>` header.
  - Parse and decode Supabase JWT tokens to extract `user_id` (`sub`) and role claims.
  - Pass `user_id` into the Request Context (`r.Context()`).
- [x] **User-Scoped History (`/history`)**:
  - Update `handleHistory` to filter queries by `user_id` so users only see their own past conversations.

---

## 2. Phase 2: Memory as a Service (MaaS) & Vector Database

### A. Supabase Vector Storage (`pgvector`) Setup
- [x] **Enable `pgvector` Extension**:
  - Run in Supabase SQL editor:
    ```sql
    CREATE EXTENSION IF NOT EXISTS vector;
    ```
- [x] **Create Vector Embeddings & Memory Table**:
  ```sql
  CREATE TABLE IF NOT EXISTS conversation_memories (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding vector(1536), -- 1536 dimensions for OpenAI text-embedding-3-small or similar
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Index for fast cosine similarity search
  CREATE INDEX IF NOT EXISTS conversation_memories_embedding_idx 
  ON conversation_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  ```

---

### B. Embedding Generation & Semantic Retrieval Engine
- [x] **Embedding Service Integration**:
  - Add an embedding helper in Go (`generateEmbedding(text string) ([]float32, error)`) calling OpenAI `text-embedding-3-small` / Gemini Embeddings, with a 1536-dim deterministic feature-hashing fallback.
- [x] **Memory Ingestion on Chat Completion**:
  - After completing a query/stream response in `saveQuery`, generate an embedding of the user prompt & answer pair and store it in `conversation_memories` (Postgres & SQLite).
- [x] **Semantic Context Retrieval (RAG)**:
  - Before sending messages to LLM providers in `/query` or `/stream`, generate an embedding of the user's prompt.
  - Query database for top $K$ most semantically relevant past memories for that `user_id`:
    ```sql
    SELECT content FROM conversation_memories
    WHERE user_id = $1
    ORDER BY embedding <=> $2
    LIMIT 3;
    ```
  - Prepend these relevant memories to the system context prompt and emit `event: memory_rag` SSE event.

---

### C. (Optional Phase 3) Advanced Managed MaaS Integration
- [ ] **Mem0 / Zep Integration**:
  - If automatic fact extraction (e.g., "User prefers Go over Python", "User is building an SSE app") is required without managing raw vectors manually, integrate **Mem0 (mem0.ai)** via its REST API.

---

## 3. Implementation Roadmap Summary

```
┌─────────────────────────────────────────────────────────┐
│ Phase 1: Authentication & Authorization                 │
│  ├── 1. Full Landing/Auth Page (Sign in, Sign up, Guest)│
│  ├── 2. Pass JWT Token from React frontend             │
│  └── 3. Go backend Auth Middleware & user_id storage    │
└────────────────────────────┬────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│ Phase 2: Memory as a Service (Vector Search)           │
│  ├── 1. Enable Supabase pgvector extension              │
│  ├── 2. Add conversation_memories table & cosine index  │
│  ├── 3. Implement Go embedding generator                │
│  └── 4. Semantic retrieval injection in LLM context     │
└────────────────────────────┴────────────────────────────┘
```
