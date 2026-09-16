package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
	_ "modernc.org/sqlite"
)

// ================= Auth & Context Middleware =================
// Secure verification for Supabase Auth JWTs (ES256 via JWKS, HS256 via secret).
// Unauthenticated requests → "guest". Present-but-invalid tokens → 401 (fail closed).

type contextKey string

const userIDKey contextKey = "user_id"

type jwtHeader struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
	Typ string `json:"typ"`
}

type jwtClaims struct {
	Sub   string `json:"sub"`
	Email string `json:"email"`
	Exp   int64  `json:"exp"`
	Iss   string `json:"iss"`
	Role  string `json:"role"`
}

type jwksKey struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	Alg string `json:"alg"`
	Use string `json:"use"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

type jwksDoc struct {
	Keys []jwksKey `json:"keys"`
}

var jwksCache = struct {
	sync.RWMutex
	keys      map[string]*ecdsa.PublicKey
	fetchedAt time.Time
}{
	keys: make(map[string]*ecdsa.PublicKey),
}

func getSupabaseURL() string {
	u := strings.TrimSpace(os.Getenv("SUPABASE_URL"))
	return strings.TrimSuffix(u, "/")
}

func getSupabaseAnonKey() string {
	return strings.TrimSpace(os.Getenv("SUPABASE_ANON_KEY"))
}

func getJWTSecret() string {
	if s := strings.TrimSpace(os.Getenv("SUPABASE_JWT_SECRET")); s != "" {
		return s
	}
	return strings.TrimSpace(os.Getenv("JWT_SECRET"))
}

func fetchJWKS(ctx context.Context) (map[string]*ecdsa.PublicKey, error) {
	supabaseURL := getSupabaseURL()
	if supabaseURL == "" {
		return nil, errors.New("SUPABASE_URL is not configured")
	}
	jwksURL := supabaseURL + "/auth/v1/.well-known/jwks.json"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, jwksURL, nil)
	if err != nil {
		return nil, err
	}
	if anon := getSupabaseAnonKey(); anon != "" {
		req.Header.Set("apikey", anon)
	}
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return nil, fmt.Errorf("jwks fetch status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var doc jwksDoc
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return nil, err
	}
	out := make(map[string]*ecdsa.PublicKey, len(doc.Keys))
	for _, k := range doc.Keys {
		if k.Kty != "EC" || k.X == "" || k.Y == "" {
			continue
		}
		xb, err1 := base64.RawURLEncoding.DecodeString(k.X)
		yb, err2 := base64.RawURLEncoding.DecodeString(k.Y)
		if err1 != nil || err2 != nil {
			continue
		}
		out[k.Kid] = &ecdsa.PublicKey{
			Curve: elliptic.P256(),
			X:     new(big.Int).SetBytes(xb),
			Y:     new(big.Int).SetBytes(yb),
		}
	}
	if len(out) == 0 {
		return nil, errors.New("jwks contained no usable EC keys")
	}
	return out, nil
}

func getJWTPublicKey(ctx context.Context, kid string) (*ecdsa.PublicKey, error) {
	jwksCache.RLock()
	key, ok := jwksCache.keys[kid]
	fresh := time.Since(jwksCache.fetchedAt) < time.Hour
	jwksCache.RUnlock()
	if ok && fresh {
		return key, nil
	}
	keys, err := fetchJWKS(ctx)
	if err != nil {
		// Serve stale key if we have one (rotation tolerance).
		if ok {
			return key, nil
		}
		return nil, err
	}
	jwksCache.Lock()
	jwksCache.keys = keys
	jwksCache.fetchedAt = time.Now()
	key, ok = keys[kid]
	jwksCache.Unlock()
	if !ok {
		return nil, fmt.Errorf("unknown key id %q", kid)
	}
	return key, nil
}

func verifyES256(headerB64, payloadB64, sigB64, kid string) (jwtClaims, error) {
	var claims jwtClaims
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	pub, err := getJWTPublicKey(ctx, kid)
	if err != nil {
		return claims, err
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil || len(sig) != 64 {
		return claims, errors.New("invalid ES256 signature encoding")
	}
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	signingInput := headerB64 + "." + payloadB64
	hash := sha256.Sum256([]byte(signingInput))
	if !ecdsa.Verify(pub, hash[:], r, s) {
		return claims, errors.New("invalid JWT signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return claims, errors.New("invalid JWT payload")
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return claims, errors.New("invalid JWT claims")
	}
	return claims, nil
}

func verifyHS256(headerB64, payloadB64, sigB64, secret string) (jwtClaims, error) {
	var claims jwtClaims
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(headerB64 + "." + payloadB64))
	expected := mac.Sum(nil)
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return claims, errors.New("invalid HS256 signature encoding")
	}
	if !hmac.Equal(sig, expected) {
		return claims, errors.New("invalid JWT signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return claims, errors.New("invalid JWT payload")
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return claims, errors.New("invalid JWT claims")
	}
	return claims, nil
}

// verifyViaSupabaseAPI falls back to asking Supabase who owns this token.
// Used when local JWKS verification is unavailable (e.g. rotation/network).
func verifyViaSupabaseAPI(ctx context.Context, token string) (string, error) {
	supabaseURL := getSupabaseURL()
	anon := getSupabaseAnonKey()
	if supabaseURL == "" || anon == "" {
		return "", errors.New("supabase API verification not configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, supabaseURL+"/auth/v1/user", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("apikey", anon)
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", errors.New("supabase rejected token")
	}
	var u struct {
		ID    string `json:"id"`
		Sub   string `json:"sub"`
		Email string `json:"email"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&u); err != nil {
		return "", err
	}
	if u.ID != "" {
		return u.ID, nil
	}
	if u.Sub != "" {
		return u.Sub, nil
	}
	if u.Email != "" {
		return u.Email, nil
	}
	return "", errors.New("supabase user has no id")
}

func verifySupabaseJWT(token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", errors.New("invalid jwt format")
	}
	headerB64, payloadB64, sigB64 := parts[0], parts[1], parts[2]
	rawHeader, err := base64.RawURLEncoding.DecodeString(headerB64)
	if err != nil {
		return "", errors.New("invalid jwt header")
	}
	var hdr jwtHeader
	if err := json.Unmarshal(rawHeader, &hdr); err != nil {
		return "", errors.New("invalid jwt header")
	}

	var claims jwtClaims
	switch hdr.Alg {
	case "ES256":
		claims, err = verifyES256(headerB64, payloadB64, sigB64, hdr.Kid)
		if err != nil {
			// Fall back to Supabase API before giving up (tolerates JWKS propagation delay).
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			if id, apiErr := verifyViaSupabaseAPI(ctx, token); apiErr == nil {
				return id, nil
			}
			return "", err
		}
	case "HS256":
		secret := getJWTSecret()
		if secret == "" {
			return "", errors.New("HS256 token but no SUPABASE_JWT_SECRET configured")
		}
		claims, err = verifyHS256(headerB64, payloadB64, sigB64, secret)
		if err != nil {
			return "", err
		}
	default:
		return "", fmt.Errorf("unsupported jwt alg %q", hdr.Alg)
	}

	if claims.Exp != 0 && time.Now().Unix() > claims.Exp+30 {
		return "", errors.New("token is expired")
	}
	// Anonymous / service keys carry no user identity — never accept them as a user.
	if claims.Sub == "" && claims.Email == "" {
		return "", errors.New("token has no user identity")
	}
	if claims.Sub != "" {
		return claims.Sub, nil
	}
	return claims.Email, nil
}

func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			// Guest mode: no token sent.
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userIDKey, "guest")))
			return
		}
		if !strings.HasPrefix(authHeader, "Bearer ") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid authorization header, expected Bearer <token>"})
			return
		}
		token := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
		if token == "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "missing bearer token"})
			return
		}
		userID, err := verifySupabaseJWT(token)
		if err != nil {
			log.Printf("auth: rejected token: %v", err)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid or expired token"})
			return
		}
		ctx := context.WithValue(r.Context(), userIDKey, userID)
		next.ServeHTTP(w, r.WithContext(ctx))
	}
}

func getUserIDFromContext(ctx context.Context) string {
	if val, ok := ctx.Value(userIDKey).(string); ok && val != "" {
		return val
	}
	return "guest"
}

// ================= Embedding & Memory Engine (Phase 2 MaaS) =================

func generateEmbedding(ctx context.Context, text string) ([]float32, error) {
	openAIKey := os.Getenv("OPENAI_API_KEY")
	if openAIKey != "" {
		vec, err := generateOpenAIEmbedding(ctx, openAIKey, text)
		if err == nil && len(vec) > 0 {
			return vec, nil
		}
		log.Println("warning: OpenAI embedding failed, attempting fallback:", err)
	}

	geminiKey := os.Getenv("GEMINI_API_KEY")
	if geminiKey != "" {
		vec, err := generateGeminiEmbedding(ctx, geminiKey, text)
		if err == nil && len(vec) > 0 {
			return vec, nil
		}
		log.Println("warning: Gemini embedding failed, attempting fallback:", err)
	}

	return generateDeterministicEmbedding(text, 1536), nil
}

func generateOpenAIEmbedding(ctx context.Context, apiKey, text string) ([]float32, error) {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"input":      text,
		"model":      "text-embedding-3-small",
		"dimensions": 1536,
	})
	req, err := http.NewRequestWithContext(ctx, "POST", "https://api.openai.com/v1/embeddings", bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("openai embedding status %d: %s", resp.StatusCode, string(b))
	}

	var res struct {
		Data []struct {
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, err
	}
	if len(res.Data) == 0 {
		return nil, errors.New("no embedding returned from openai")
	}
	return res.Data[0].Embedding, nil
}

func generateGeminiEmbedding(ctx context.Context, apiKey, text string) ([]float32, error) {
	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=%s", apiKey)
	reqBody, _ := json.Marshal(map[string]interface{}{
		"model": "models/gemini-embedding-001",
		"content": map[string]interface{}{
			"parts": []map[string]string{{"text": text}},
		},
		"outputDimensionality": 1536, // request 1536 directly instead of truncating 3072
	})
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("gemini embedding status %d: %s", resp.StatusCode, string(b))
	}

	var res struct {
		Embedding struct {
			Values []float32 `json:"values"`
		} `json:"embedding"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, err
	}
	values := res.Embedding.Values
	if len(values) == 0 {
		return nil, errors.New("no embedding values returned from gemini")
	}
	if len(values) < 1536 {
		padded := make([]float32, 1536)
		copy(padded, values)
		return padded, nil
	}
	return values[:1536], nil
}

func generateDeterministicEmbedding(text string, dims int) []float32 {
	vec := make([]float32, dims)
	words := strings.Fields(strings.ToLower(text))
	for _, w := range words {
		var h uint32 = 2166136261
		for i := 0; i < len(w); i++ {
			h ^= uint32(w[i])
			h *= 16777619
		}
		idx := int(h % uint32(dims))
		sign := float32(1.0)
		if (h & 1) == 1 {
			sign = -1.0
		}
		vec[idx] += sign
	}
	var sumSq float64
	for _, v := range vec {
		sumSq += float64(v * v)
	}
	if sumSq > 0 {
		norm := float32(math.Sqrt(sumSq))
		for i := range vec {
			vec[i] /= norm
		}
	}
	return vec
}

func cosineSimilarity(a, b []float32) float32 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, normA, normB float64
	for i := 0; i < len(a); i++ {
		dot += float64(a[i] * b[i])
		normA += float64(a[i] * a[i])
		normB += float64(b[i] * b[i])
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return float32(dot / (math.Sqrt(normA) * math.Sqrt(normB)))
}

func formatVectorForSQL(vec []float32) string {
	var sb strings.Builder
	sb.WriteString("[")
	for i, v := range vec {
		if i > 0 {
			sb.WriteString(",")
		}
		sb.WriteString(fmt.Sprintf("%f", v))
	}
	sb.WriteString("]")
	return sb.String()
}

func saveMemory(userID, prompt, answer string) {
	if activeDB == nil || prompt == "" || answer == "" {
		return
	}
	content := fmt.Sprintf("User: %s\nAssistant: %s", prompt, answer)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	emb, err := generateEmbedding(ctx, content)
	if err != nil {
		log.Println("saveMemory embedding error:", err)
		return
	}

	if activeDB.driver == "postgres" {
		vecStr := formatVectorForSQL(emb)
		_, err = activeDB.pgPool.Exec(ctx,
			"INSERT INTO conversation_memories (user_id, content, embedding) VALUES ($1, $2, $3::vector)",
			userID, content, vecStr,
		)
	} else if activeDB.driver == "sqlite" {
		embJSON, _ := json.Marshal(emb)
		_, err = activeDB.sqlDB.Exec(
			"INSERT INTO conversation_memories (user_id, content, embedding) VALUES (?, ?, ?)",
			userID, content, string(embJSON),
		)
	}
	if err != nil {
		log.Println("saveMemory DB insert error:", err)
	}
}

func retrieveRelevantMemories(ctx context.Context, userID, prompt string, topK int) ([]string, error) {
	if activeDB == nil || prompt == "" {
		return nil, nil
	}
	emb, err := generateEmbedding(ctx, prompt)
	if err != nil {
		return nil, err
	}

	var results []string
	if activeDB.driver == "postgres" {
		vecStr := formatVectorForSQL(emb)
		rows, err := activeDB.pgPool.Query(ctx,
			"SELECT content FROM conversation_memories WHERE user_id = $1 ORDER BY embedding <=> $2::vector LIMIT $3",
			userID, vecStr, topK,
		)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var content string
			if err := rows.Scan(&content); err == nil {
				results = append(results, content)
			}
		}
	} else if activeDB.driver == "sqlite" {
		rows, err := activeDB.sqlDB.Query(
			"SELECT content, embedding FROM conversation_memories WHERE user_id = ? ORDER BY id DESC LIMIT 200",
			userID,
		)
		if err != nil {
			return nil, err
		}
		defer rows.Close()

		type scoredMemory struct {
			content string
			score   float32
		}
		var scored []scoredMemory

		for rows.Next() {
			var content, embStr string
			if err := rows.Scan(&content, &embStr); err != nil {
				continue
			}
			var memEmb []float32
			if err := json.Unmarshal([]byte(embStr), &memEmb); err != nil {
				continue
			}
			score := cosineSimilarity(emb, memEmb)
			if score > 0.15 {
				scored = append(scored, scoredMemory{content: content, score: score})
			}
		}

		for i := 0; i < len(scored)-1; i++ {
			for j := i + 1; j < len(scored); j++ {
				if scored[j].score > scored[i].score {
					scored[i], scored[j] = scored[j], scored[i]
				}
			}
		}

		for i := 0; i < len(scored) && i < topK; i++ {
			results = append(results, scored[i].content)
		}
	}

	return results, nil
}

func injectMemoryRAGContext(ctx context.Context, userID, lastPrompt string, history []message) ([]message, bool) {
	if lastPrompt == "" {
		return history, false
	}
	memories, err := retrieveRelevantMemories(ctx, userID, lastPrompt, 3)
	if err != nil || len(memories) == 0 {
		return history, false
	}

	var sb strings.Builder
	sb.WriteString("Below is relevant past conversation memory retrieved for this user via Semantic Vector Search (RAG):\n")
	for i, mem := range memories {
		sb.WriteString(fmt.Sprintf("[%d] %s\n", i+1, mem))
	}
	sb.WriteString("\nUse this background memory to maintain context if relevant. Do not explicitly cite internal memory IDs unless requested.")

	memorySysMsg := message{
		Role:    "system",
		Content: sb.String(),
	}

	var newHistory []message
	hasSystem := false
	for _, m := range history {
		if m.Role == "system" && !hasSystem {
			newHistory = append(newHistory, message{
				Role:    "system",
				Content: m.Content + "\n\n" + sb.String(),
			})
			hasSystem = true
		} else {
			newHistory = append(newHistory, m)
		}
	}
	if !hasSystem {
		newHistory = append([]message{memorySysMsg}, history...)
	}

	return newHistory, true
}

type memoryRecord struct {
	ID        int    `json:"id"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

func handleMemories(w http.ResponseWriter, r *http.Request) {
	if activeDB == nil {
		http.Error(w, "database not connected", http.StatusServiceUnavailable)
		return
	}
	userID := getUserIDFromContext(r.Context())

	switch r.Method {
	case http.MethodGet:
		var records []memoryRecord
		if activeDB.driver == "postgres" {
			rows, err := activeDB.pgPool.Query(context.Background(),
				"SELECT id, content, created_at::text FROM conversation_memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
				userID,
			)
			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var rec memoryRecord
					if err := rows.Scan(&rec.ID, &rec.Content, &rec.CreatedAt); err == nil {
						records = append(records, rec)
					}
				}
			}
		} else if activeDB.driver == "sqlite" {
			rows, err := activeDB.sqlDB.Query(
				"SELECT id, content, datetime(created_at) FROM conversation_memories WHERE user_id = ? ORDER BY id DESC LIMIT 50",
				userID,
			)
			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var rec memoryRecord
					if err := rows.Scan(&rec.ID, &rec.Content, &rec.CreatedAt); err == nil {
						records = append(records, rec)
					}
				}
			}
		}
		if records == nil {
			records = []memoryRecord{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(records)

	case http.MethodDelete:
		if activeDB.driver == "postgres" {
			_, _ = activeDB.pgPool.Exec(context.Background(), "DELETE FROM conversation_memories WHERE user_id = $1", userID)
		} else if activeDB.driver == "sqlite" {
			_, _ = activeDB.sqlDB.Exec("DELETE FROM conversation_memories WHERE user_id = ?", userID)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "memories cleared"})

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// ================= Provider Metrics (Smart Router) =================

// providerCostPer1K holds approximate cost per 1K output tokens in USD.
var providerCostPer1K = map[string]float64{
	"groq":     0.00059, // groq/compound
	"mistral":  0.00200, // mistral-small-latest
	"chatgpt":  0.00600, // gpt-4o-mini
	"gemini":   0.00035, // gemini-2.5-flash
	"deepseek": 0.00027, // deepseek-v4-flash
}

type providerMetrics struct {
	mu           sync.RWMutex
	emaLatencyMs map[string]float64
	callCount    map[string]int64
	errorCount   map[string]int64
}

var pMetrics = &providerMetrics{
	// Seed with reasonable defaults so first auto-route isn't arbitrary.
	emaLatencyMs: map[string]float64{
		"groq":     200,
		"mistral":  400,
		"chatgpt":  300,
		"gemini":   350,
		"deepseek": 250,
	},
	callCount:  make(map[string]int64),
	errorCount: make(map[string]int64),
}

func (m *providerMetrics) record(provider string, latencyMs float64, failed bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.callCount[provider]++
	if failed {
		m.errorCount[provider]++
		return
	}
	const alpha = 0.3 // EMA factor — higher = more weight on recent calls
	m.emaLatencyMs[provider] = alpha*latencyMs + (1-alpha)*m.emaLatencyMs[provider]
}

func (m *providerMetrics) score(provider string) float64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	// Normalize latency (ceiling 3 s) and cost (ceiling $0.01/1K).
	nLatency := math.Min(m.emaLatencyMs[provider]/3000.0, 1.0)
	nCost := math.Min(providerCostPer1K[provider]/0.01, 1.0)
	// 60 % weight on speed, 40 % on cost → lower score is better.
	return 0.6*nLatency + 0.4*nCost
}

func (m *providerMetrics) snapshot() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]interface{})
	for _, p := range []string{"groq", "mistral", "chatgpt", "gemini", "deepseek"} {
		out[p] = map[string]interface{}{
			"ema_latency_ms":  math.Round(m.emaLatencyMs[p]*10) / 10,
			"cost_per_1k_usd": providerCostPer1K[p],
			"calls":           m.callCount[p],
			"errors":          m.errorCount[p],
			"score":           math.Round(m.score(p)*1000) / 1000,
		}
	}
	return out
}

// ================= Shared message/response shapes =================

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []message `json:"messages"`
	Stream   bool      `json:"stream,omitempty"`
}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	Choices []struct {
		Message message `json:"message"`
	} `json:"choices"`
}

// ================= SSE chunk shapes (OpenAI-compatible streaming) =================

type streamChoice struct {
	Delta struct {
		Content string `json:"content"`
	} `json:"delta"`
	FinishReason *string `json:"finish_reason"`
}

type streamChunk struct {
	Choices []streamChoice `json:"choices"`
}

// ================= Groq adapter =================

func callGroq(history []message) (string, error) {
	apiKey := os.Getenv("GROQ_API_KEY")
	if apiKey == "" {
		return "", errors.New("GROQ_API_KEY environment variable is not set")
	}
	reqBody := chatRequest{Model: "groq/compound", Messages: history}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	t0 := time.Now()
	res, err := sendChatRequest(ctx, "https://api.groq.com/openai/v1/chat/completions", apiKey, reqBody, "groq")
	pMetrics.record("groq", float64(time.Since(t0).Milliseconds()), err != nil)
	return res, err
}

func streamGroq(ctx context.Context, history []message, out chan<- string) error {
	apiKey := os.Getenv("GROQ_API_KEY")
	if apiKey == "" {
		return errors.New("GROQ_API_KEY not set")
	}
	t0 := time.Now()
	err := streamOpenAICompat(ctx, "https://api.groq.com/openai/v1/chat/completions", apiKey, "groq/compound", history, out)
	pMetrics.record("groq", float64(time.Since(t0).Milliseconds()), err != nil)
	return err
}

// ================= Mistral adapter =================

func callMistral(history []message) (string, error) {
	apiKey := os.Getenv("MISTRAL_API_KEY")
	if apiKey == "" {
		return "", errors.New("MISTRAL_API_KEY environment variable is not set")
	}
	reqBody := chatRequest{Model: "mistral-small-latest", Messages: history}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	t0 := time.Now()
	res, err := sendChatRequest(ctx, "https://api.mistral.ai/v1/chat/completions", apiKey, reqBody, "mistral")
	pMetrics.record("mistral", float64(time.Since(t0).Milliseconds()), err != nil)
	return res, err
}

func streamMistral(ctx context.Context, history []message, out chan<- string) error {
	apiKey := os.Getenv("MISTRAL_API_KEY")
	if apiKey == "" {
		return errors.New("MISTRAL_API_KEY not set")
	}
	t0 := time.Now()
	err := streamOpenAICompat(ctx, "https://api.mistral.ai/v1/chat/completions", apiKey, "mistral-small-latest", history, out)
	pMetrics.record("mistral", float64(time.Since(t0).Milliseconds()), err != nil)
	return err
}

// ================= OpenAI (ChatGPT) adapter =================

func callOpenAI(history []message) (string, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return "", errors.New("OPENAI_API_KEY environment variable is not set")
	}
	reqBody := chatRequest{Model: "gpt-4o-mini", Messages: history}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	t0 := time.Now()
	res, err := sendChatRequest(ctx, "https://api.openai.com/v1/chat/completions", apiKey, reqBody, "chatgpt")
	pMetrics.record("chatgpt", float64(time.Since(t0).Milliseconds()), err != nil)
	return res, err
}

func streamOpenAI(ctx context.Context, history []message, out chan<- string) error {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return errors.New("OPENAI_API_KEY not set")
	}
	t0 := time.Now()
	err := streamOpenAICompat(ctx, "https://api.openai.com/v1/chat/completions", apiKey, "gpt-4o-mini", history, out)
	pMetrics.record("chatgpt", float64(time.Since(t0).Milliseconds()), err != nil)
	return err
}

// ================= Gemini adapter =================

type geminiPart struct {
	Text string `json:"text"`
}
type geminiContent struct {
	Role  string       `json:"role"`
	Parts []geminiPart `json:"parts"`
}
type geminiRequest struct {
	Contents []geminiContent `json:"contents"`
}
type geminiResponse struct {
	Candidates []struct {
		Content struct {
			Parts []geminiPart `json:"parts"`
		} `json:"content"`
	} `json:"candidates"`
}

func callGemini(history []message) (string, error) {
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		return "", errors.New("GEMINI_API_KEY environment variable is not set")
	}
	contents := buildGeminiContents(history)
	reqBody := geminiRequest{Contents: contents}
	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}
	url := "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + apiKey
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	client := &http.Client{Timeout: 30 * time.Second}
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(jsonBody))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	t0 := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		pMetrics.record("gemini", 0, true)
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		pMetrics.record("gemini", 0, true)
		return "", fmt.Errorf("gemini API error (status %d): %s", resp.StatusCode, string(body))
	}
	var result geminiResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return "", err
	}
	if len(result.Candidates) == 0 || len(result.Candidates[0].Content.Parts) == 0 {
		return "", errors.New("gemini returned no candidates")
	}
	pMetrics.record("gemini", float64(time.Since(t0).Milliseconds()), false)
	return result.Candidates[0].Content.Parts[0].Text, nil
}

// ================= DeepSeek adapter =================

func callDeepseek(history []message) (string, error) {
	apiKey := os.Getenv("DEEPSEEK_API_KEY")
	if apiKey == "" {
		return "", errors.New("DEEPSEEK_API_KEY environment variable is not set")
	}
	reqBody := chatRequest{Model: "deepseek-v4-flash", Messages: history}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	t0 := time.Now()
	res, err := sendChatRequest(ctx, "https://integrate.api.nvidia.com/v1", apiKey, reqBody, "deepseek")
	pMetrics.record("deepseek", float64(time.Since(t0).Milliseconds()), err != nil)
	return res, err
}

func streamDeepseek(ctx context.Context, history []message, out chan<- string) error {
	apiKey := os.Getenv("DEEPSEEK_API_KEY")
	if apiKey == "" {
		return errors.New("DEEPSEEK_API_KEY not set")
	}
	t0 := time.Now()
	err := streamOpenAICompat(ctx, "https://integrate.api.nvidia.com/v1", apiKey, "deepseek-v4-flash", history, out)
	pMetrics.record("deepseek", float64(time.Since(t0).Milliseconds()), err != nil)
	return err
}

// streamGemini: Real token-level SSE streaming via Gemini's streamGenerateContent endpoint.
func streamGemini(ctx context.Context, history []message, out chan<- string) error {
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		return errors.New("GEMINI_API_KEY not set")
	}
	contents := buildGeminiContents(history)
	reqBody := geminiRequest{Contents: contents}
	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return err
	}
	url := "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=" + apiKey
	client := &http.Client{Timeout: 120 * time.Second}
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(jsonBody))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	t0 := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		pMetrics.record("gemini", 0, true)
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		pMetrics.record("gemini", 0, true)
		return fmt.Errorf("gemini stream error (%d): %s", resp.StatusCode, string(body))
	}
	// Gemini SSE chunk shape
	type geminiStreamChunk struct {
		Candidates []struct {
			Content struct {
				Parts []geminiPart `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			break
		}
		var chunk geminiStreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if len(chunk.Candidates) > 0 && len(chunk.Candidates[0].Content.Parts) > 0 {
			token := chunk.Candidates[0].Content.Parts[0].Text
			if token != "" {
				out <- token
			}
		}
	}
	pMetrics.record("gemini", float64(time.Since(t0).Milliseconds()), false)
	return scanner.Err()
}

// buildGeminiContents converts OpenAI-style history to Gemini's content format.
func buildGeminiContents(history []message) []geminiContent {
	var contents []geminiContent
	for _, m := range history {
		role := m.Role
		if role == "assistant" {
			role = "model"
		}
		if role == "system" {
			continue // Gemini doesn't support system role in v1beta contents
		}
		contents = append(contents, geminiContent{Role: role, Parts: []geminiPart{{Text: m.Content}}})
	}
	return contents
}

// ================= OpenAI-compatible SSE streaming helper =================

func streamOpenAICompat(ctx context.Context, url, apiKey, model string, history []message, out chan<- string) error {
	reqBody := chatRequest{Model: model, Messages: history, Stream: true}
	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 120 * time.Second}
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(jsonBody))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error (%d): %s", resp.StatusCode, string(body))
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			break
		}
		var chunk streamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if len(chunk.Choices) > 0 {
			token := chunk.Choices[0].Delta.Content
			if token != "" {
				out <- token
			}
		}
	}
	return scanner.Err()
}

// ================= Ensemble mode (non-streaming) =================

type providerResult struct {
	Provider string
	Answer   string
	Err      error
}

func callEnsemble(history []message) (string, map[string]string, error) {
	results := make([]providerResult, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		answer, err := callGroq(history)
		results[0] = providerResult{Provider: "groq", Answer: answer, Err: err}
	}()
	go func() {
		defer wg.Done()
		answer, err := callMistral(history)
		results[1] = providerResult{Provider: "mistral", Answer: answer, Err: err}
	}()
	wg.Wait()

	rawAnswers := make(map[string]string)
	var validAnswers []string
	for _, r := range results {
		if r.Err != nil {
			log.Printf("ensemble: %s failed: %v", r.Provider, r.Err)
			continue
		}
		rawAnswers[r.Provider] = r.Answer
		validAnswers = append(validAnswers, fmt.Sprintf("%s said: %s", r.Provider, r.Answer))
	}
	if len(validAnswers) == 0 {
		return "", nil, errors.New("both providers failed in ensemble mode")
	}
	lastPrompt := ""
	for i := len(history) - 1; i >= 0; i-- {
		if history[i].Role == "user" {
			lastPrompt = history[i].Content
			break
		}
	}
	synthesisPrompt := fmt.Sprintf(
		"Here are answers from two different AI models to the same question: %q\n\n%s\n\nCombine them into one clear, best final answer. Just give the answer, no commentary about the models.",
		lastPrompt, strings.Join(validAnswers, "\n"),
	)
	synthesisHistory := []message{{Role: "user", Content: synthesisPrompt}}
	final, err := callGroq(synthesisHistory)
	if err != nil {
		return "", rawAnswers, err
	}
	return final, rawAnswers, nil
}

// ================= Shared HTTP call logic =================

func sendChatRequest(ctx context.Context, url, apiKey string, reqBody chatRequest, providerName string) (string, error) {
	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}
	client := &http.Client{Timeout: 30 * time.Second}
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(jsonBody))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s API error (status %d): %s", providerName, resp.StatusCode, string(body))
	}
	var result chatResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return "", err
	}
	if len(result.Choices) == 0 {
		return "", fmt.Errorf("%s returned no choices", providerName)
	}
	return result.Choices[0].Message.Content, nil
}

// ================= Router =================

// selectProvider picks the best provider using a composite score of
// EMA latency (60 %) and cost-per-token (40 %). Falls back to groq
// when no meaningful data exists yet.
func selectProvider(_ string) string {
	candidates := []string{"groq", "mistral", "gemini"} // exclude chatgpt from auto (higher cost)
	best := candidates[0]
	bestScore := pMetrics.score(best)
	for _, p := range candidates[1:] {
		if s := pMetrics.score(p); s < bestScore {
			bestScore = s
			best = p
		}
	}
	return best
}

// ================= Database =================

type DBBackend struct {
	driver string // "postgres" or "sqlite"
	pgPool *pgxpool.Pool
	sqlDB  *sql.DB
}

var activeDB *DBBackend

func connectDB() error {
	dbURL := os.Getenv("SUPABASE_DB_URL")
	if dbURL != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		pool, err := pgxpool.New(ctx, dbURL)
		if err == nil {
			if err := pool.Ping(ctx); err == nil {
				log.Println("connected to Supabase PostgreSQL")
				_, _ = pool.Exec(context.Background(), `
					CREATE EXTENSION IF NOT EXISTS vector;
					CREATE TABLE IF NOT EXISTS queries (
						id BIGSERIAL PRIMARY KEY,
						user_id TEXT DEFAULT 'guest',
						prompt TEXT NOT NULL,
						provider TEXT NOT NULL,
						answer TEXT NOT NULL,
						created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
					);
					ALTER TABLE queries ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT 'guest';
					CREATE TABLE IF NOT EXISTS conversation_memories (
						id BIGSERIAL PRIMARY KEY,
						user_id TEXT NOT NULL,
						content TEXT NOT NULL,
						embedding vector(1536),
						metadata JSONB DEFAULT '{}'::jsonb,
						created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
					);
					CREATE INDEX IF NOT EXISTS conversation_memories_user_idx ON conversation_memories (user_id);
				`)
				activeDB = &DBBackend{driver: "postgres", pgPool: pool}
				return nil
			}
			log.Printf("warning: could not connect to Supabase PostgreSQL (%v)", err)
		} else {
			log.Printf("warning: invalid Supabase DB URL configuration (%v)", err)
		}
	} else {
		log.Println("SUPABASE_DB_URL not configured")
	}

	log.Println("initiating local SQLite database fallback (nexus.db)")
	sdb, err := sql.Open("sqlite", "nexus.db")
	if err != nil {
		return fmt.Errorf("failed to open local sqlite db: %w", err)
	}

	_, err = sdb.Exec(`
		CREATE TABLE IF NOT EXISTS queries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT DEFAULT 'guest',
			prompt TEXT NOT NULL,
			provider TEXT NOT NULL,
			answer TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS conversation_memories (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL,
			content TEXT NOT NULL,
			embedding TEXT NOT NULL,
			metadata TEXT DEFAULT '{}',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`)
	if err != nil {
		return fmt.Errorf("failed to create sqlite schema: %w", err)
	}

	// Gracefully add column to sqlite if existing table doesn't have user_id
	_, _ = sdb.Exec(`ALTER TABLE queries ADD COLUMN user_id TEXT DEFAULT 'guest';`)

	activeDB = &DBBackend{driver: "sqlite", sqlDB: sdb}
	log.Println("connected to local SQLite database (nexus.db)")
	return nil
}

func saveQuery(userID, prompt, provider, answer string) {
	if activeDB == nil {
		return
	}
	if userID == "" {
		userID = "guest"
	}
	var err error
	if activeDB.driver == "postgres" {
		_, err = activeDB.pgPool.Exec(context.Background(),
			"INSERT INTO queries (user_id, prompt, provider, answer) VALUES ($1, $2, $3, $4)",
			userID, prompt, provider, answer,
		)
	} else if activeDB.driver == "sqlite" {
		_, err = activeDB.sqlDB.Exec(
			"INSERT INTO queries (user_id, prompt, provider, answer) VALUES (?, ?, ?, ?)",
			userID, prompt, provider, answer,
		)
	}
	if err != nil {
		log.Println("saveQuery error:", err)
	}

	// Save vector embedding memory asynchronously for RAG semantic search
	go saveMemory(userID, prompt, answer)
}

// ================= /query request/response shape =================

type queryRequest struct {
	History  []message `json:"history"`
	Provider string    `json:"provider"`
	Prompt   string    `json:"prompt"` // legacy single-prompt fallback
}

type queryResponse struct {
	Provider   string            `json:"provider"`
	Answer     string            `json:"answer"`
	RawAnswers map[string]string `json:"raw_answers,omitempty"`
}

// ================= /summarize request/response shape =================

type summarizeRequest struct {
	History      []message `json:"history"`
	FromProvider string    `json:"from_provider"`
	ToProvider   string    `json:"to_provider"`
}

type summarizeResponse struct {
	Summary string `json:"summary"`
}

func handleSummarize(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "only POST is allowed", http.StatusMethodNotAllowed)
		return
	}
	var req summarizeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if len(req.History) == 0 {
		http.Error(w, `"history" field is required`, http.StatusBadRequest)
		return
	}
	var transcript strings.Builder
	for _, m := range req.History {
		role := m.Role
		if len(role) > 0 {
			role = strings.ToUpper(role[:1]) + role[1:]
		}
		transcript.WriteString(fmt.Sprintf("%s: %s\n\n", role, m.Content))
	}
	summaryPrompt := fmt.Sprintf(
		`You are taking over a conversation from %s. Here is the full conversation history so far:

---
%s
---

Please create a concise but thorough handoff summary (3-5 sentences) that captures:
1. The main topic(s) discussed
2. Key facts, answers, or conclusions reached
3. Any unresolved questions or next steps the user had in mind

This summary will be given to you (as %s) as context before the user's next message. Write it in first-person as if you already knew this context. Do not mention the model switch.`,
		req.FromProvider,
		transcript.String(),
		req.ToProvider,
	)
	summaryHistory := []message{{Role: "user", Content: summaryPrompt}}
	var summary string
	var err error
	switch req.ToProvider {
	case "groq":
		summary, err = callGroq(summaryHistory)
	case "mistral":
		summary, err = callMistral(summaryHistory)
	case "chatgpt":
		summary, err = callOpenAI(summaryHistory)
	case "gemini":
		summary, err = callGemini(summaryHistory)
	case "deepseek":
		summary, err = callDeepseek(summaryHistory)
	default:
		summary, err = callGroq(summaryHistory)
	}
	if err != nil {
		log.Printf("handleSummarize error: %v", err)
		http.Error(w, "failed to generate summary", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(summarizeResponse{Summary: summary})
}

// ================= /query HTTP handler =================

func handleQuery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "only POST is allowed", http.StatusMethodNotAllowed)
		return
	}
	var req queryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	var history []message
	if len(req.History) > 0 {
		history = req.History
	} else if req.Prompt != "" {
		history = []message{{Role: "user", Content: req.Prompt}}
	} else {
		http.Error(w, `"history" or "prompt" field is required`, http.StatusBadRequest)
		return
	}
	lastPrompt := ""
	for i := len(history) - 1; i >= 0; i-- {
		if history[i].Role == "user" {
			lastPrompt = history[i].Content
			break
		}
	}
	userID := getUserIDFromContext(r.Context())
	history, _ = injectMemoryRAGContext(r.Context(), userID, lastPrompt, history)

	provider := req.Provider
	if provider == "" || provider == "auto" {
		provider = selectProvider(lastPrompt)
	}
	var answer string
	var rawAnswers map[string]string
	var err error
	switch provider {
	case "groq":
		answer, err = callGroq(history)
	case "mistral":
		answer, err = callMistral(history)
	case "chatgpt":
		answer, err = callOpenAI(history)
	case "gemini":
		answer, err = callGemini(history)
	case "deepseek":
		answer, err = callDeepseek(history)
	case "ensemble":
		answer, rawAnswers, err = callEnsemble(history)
	default:
		http.Error(w, fmt.Sprintf(`unknown provider %q`, provider), http.StatusBadRequest)
		return
	}
	if err != nil {
		log.Printf("call%s error: %v", provider, err)
		http.Error(w, fmt.Sprintf("failed to get response from %s: %v", provider, err), http.StatusInternalServerError)
		return
	}
	userID = getUserIDFromContext(r.Context())
	saveQuery(userID, lastPrompt, provider, answer)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(queryResponse{Provider: provider, Answer: answer, RawAnswers: rawAnswers})
}

// ================= /stream SSE handler =================
// Streams tokens as Server-Sent Events (text/event-stream).
// Each token is sent as:   data: <token>\n\n
// On completion:           data: [DONE]\n\n  (with X-Provider and X-Answer trailers encoded in a final event)
// On error:                event: error\ndata: <message>\n\n

func handleStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "only POST is allowed", http.StatusMethodNotAllowed)
		return
	}

	// SSE headers — must be set before any write
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering if behind proxy

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	var req queryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fmt.Fprintf(w, "event: error\ndata: invalid JSON body\n\n")
		flusher.Flush()
		return
	}

	var history []message
	if len(req.History) > 0 {
		history = req.History
	} else if req.Prompt != "" {
		history = []message{{Role: "user", Content: req.Prompt}}
	} else {
		fmt.Fprintf(w, "event: error\ndata: history or prompt required\n\n")
		flusher.Flush()
		return
	}

	lastPrompt := ""
	for i := len(history) - 1; i >= 0; i-- {
		if history[i].Role == "user" {
			lastPrompt = history[i].Content
			break
		}
	}

	provider := req.Provider
	if provider == "" || provider == "auto" {
		provider = selectProvider(lastPrompt)
	}

	userID := getUserIDFromContext(r.Context())
	history, ragInjected := injectMemoryRAGContext(r.Context(), userID, lastPrompt, req.History)
	if ragInjected {
		fmt.Fprintf(w, "event: memory_rag\ndata: {\"status\":\"active\"}\n\n")
		flusher.Flush()
	}
	providerJSON, _ := json.Marshal(provider)
	fmt.Fprintf(w, "event: provider\ndata: %s\n\n", providerJSON)
	flusher.Flush()

	ctx := r.Context()

	// ── Ensemble: non-streaming, emit whole answer as one token ──
	if provider == "ensemble" {
		answer, rawAnswers, err := callEnsemble(history)
		if err != nil {
			fmt.Fprintf(w, "event: error\ndata: %s\n\n", jsonEscape(err.Error()))
			flusher.Flush()
			return
		}
		// Emit the full answer as a single token chunk
		tokenJSON, _ := json.Marshal(answer)
		fmt.Fprintf(w, "data: %s\n\n", tokenJSON)
		flusher.Flush()

		// Emit raw_answers metadata
		rawJSON, _ := json.Marshal(rawAnswers)
		fmt.Fprintf(w, "event: raw_answers\ndata: %s\n\n", rawJSON)
		flusher.Flush()

		userID := getUserIDFromContext(ctx)
		saveQuery(userID, lastPrompt, provider, answer)
		fmt.Fprintf(w, "event: done\ndata: {}\n\n")
		flusher.Flush()
		return
	}

	// ── Streaming providers ──
	tokenCh := make(chan string, 64)
	errCh := make(chan error, 1)

	go func() {
		defer close(tokenCh)
		var err error
		switch provider {
		case "groq":
			err = streamGroq(ctx, history, tokenCh)
		case "mistral":
			err = streamMistral(ctx, history, tokenCh)
		case "chatgpt":
			err = streamOpenAI(ctx, history, tokenCh)
		case "gemini":
			err = streamGemini(ctx, history, tokenCh)
		case "deepseek":
			err = streamDeepseek(ctx, history, tokenCh)
		default:
			err = fmt.Errorf("unknown provider %q", provider)
		}
		if err != nil {
			errCh <- err
		}
	}()

	var fullAnswer strings.Builder

	for {
		select {
		case <-ctx.Done():
			return
		case err := <-errCh:
			fmt.Fprintf(w, "event: error\ndata: %s\n\n", jsonEscape(err.Error()))
			flusher.Flush()
			return
		case token, open := <-tokenCh:
			if !open {
				// Channel closed — streaming complete
				userID := getUserIDFromContext(ctx)
				saveQuery(userID, lastPrompt, provider, fullAnswer.String())
				fmt.Fprintf(w, "event: done\ndata: {}\n\n")
				flusher.Flush()
				return
			}
			fullAnswer.WriteString(token)
			tokenJSON, _ := json.Marshal(token)
			fmt.Fprintf(w, "data: %s\n\n", tokenJSON)
			flusher.Flush()
		}
	}
}

func jsonEscape(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// ================= /history HTTP handler =================

type historyRecord struct {
	ID        int    `json:"id"`
	Prompt    string `json:"prompt"`
	Provider  string `json:"provider"`
	Answer    string `json:"answer"`
	CreatedAt string `json:"created_at"`
}

func handleHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "only GET is allowed", http.StatusMethodNotAllowed)
		return
	}
	if activeDB == nil {
		http.Error(w, "database not connected", http.StatusServiceUnavailable)
		return
	}
	userID := getUserIDFromContext(r.Context())
	var records []historyRecord
	if activeDB.driver == "postgres" {
		rows, err := activeDB.pgPool.Query(context.Background(),
			"SELECT id, prompt, provider, answer, created_at::text FROM queries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
			userID,
		)
		if err != nil {
			log.Println("handleHistory query error:", err)
			http.Error(w, "failed to fetch history", http.StatusInternalServerError)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var rec historyRecord
			if err := rows.Scan(&rec.ID, &rec.Prompt, &rec.Provider, &rec.Answer, &rec.CreatedAt); err != nil {
				log.Println("handleHistory scan error:", err)
				continue
			}
			records = append(records, rec)
		}
	} else if activeDB.driver == "sqlite" {
		rows, err := activeDB.sqlDB.Query(
			"SELECT id, prompt, provider, answer, datetime(created_at) FROM queries WHERE user_id = ? ORDER BY created_at DESC LIMIT 100",
			userID,
		)
		if err != nil {
			log.Println("handleHistory sqlite query error:", err)
			http.Error(w, "failed to fetch history", http.StatusInternalServerError)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var rec historyRecord
			if err := rows.Scan(&rec.ID, &rec.Prompt, &rec.Provider, &rec.Answer, &rec.CreatedAt); err != nil {
				log.Println("handleHistory scan error:", err)
				continue
			}
			records = append(records, rec)
		}
	}
	if records == nil {
		records = []historyRecord{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(records)
}

// ================= CORS Handling =================

func enableCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next(w, r)
	}
}

// ================= main =================

func main() {
	if err := godotenv.Load(); err != nil {
		log.Println("no .env file found, relying on system environment variables")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	if err := connectDB(); err != nil {
		log.Println("warning: database initialization failed:", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", enableCORS(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		dbDriver := "none"
		if activeDB != nil {
			dbDriver = activeDB.driver
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{
			"status":   "ok",
			"database": dbDriver,
		})
	}))
	mux.HandleFunc("/query", enableCORS(authMiddleware(handleQuery)))
	mux.HandleFunc("/stream", enableCORS(authMiddleware(handleStream)))
	mux.HandleFunc("/history", enableCORS(authMiddleware(handleHistory)))
	mux.HandleFunc("/summarize", enableCORS(authMiddleware(handleSummarize)))
	mux.HandleFunc("/memories", enableCORS(authMiddleware(handleMemories)))
	// /metrics — live provider latency, cost, and routing scores
	mux.HandleFunc("/metrics", enableCORS(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "only GET is allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(pMetrics.snapshot())
	}))

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  35 * time.Second,
		WriteTimeout: 120 * time.Second, // longer for streaming
		IdleTimeout:  60 * time.Second,
	}
	log.Printf("nexus orchestrator-api listening on :%s", port)
	if err := server.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
