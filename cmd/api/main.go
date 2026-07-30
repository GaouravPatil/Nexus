package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

// ================= Shared message/response shapes =================

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []message `json:"messages"`
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

// ================= Groq adapter =================

func callGroq(history []message) (string, error) {
	apiKey := os.Getenv("GROQ_API_KEY")
	if apiKey == "" {
		return "", errors.New("GROQ_API_KEY environment variable is not set")
	}

	reqBody := chatRequest{
		Model:    "llama-3.3-70b-versatile",
		Messages: history,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	return sendChatRequest(ctx, "https://api.groq.com/openai/v1/chat/completions", apiKey, reqBody, "groq")
}

// ================= Mistral adapter =================

func callMistral(history []message) (string, error) {
	apiKey := os.Getenv("MISTRAL_API_KEY")
	if apiKey == "" {
		return "", errors.New("MISTRAL_API_KEY environment variable is not set")
	}

	reqBody := chatRequest{
		Model:    "mistral-small-latest",
		Messages: history,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	return sendChatRequest(ctx, "https://api.mistral.ai/v1/chat/completions", apiKey, reqBody, "mistral")
}

// ================= OpenAI (ChatGPT) adapter =================

func callOpenAI(history []message) (string, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return "", errors.New("OPENAI_API_KEY environment variable is not set")
	}

	reqBody := chatRequest{
		Model:    "gpt-4o-mini", // cost-effective; swap to "gpt-4o" for higher quality
		Messages: history,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	return sendChatRequest(ctx, "https://api.openai.com/v1/chat/completions", apiKey, reqBody, "chatgpt")
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

	// Gemini uses "user" and "model" roles, not "assistant"
	var contents []geminiContent
	for _, m := range history {
		role := m.Role
		if role == "assistant" {
			role = "model"
		}
		// Gemini does not accept "system" roles directly — prepend to first user msg
		if role == "system" {
			continue
		}
		contents = append(contents, geminiContent{
			Role:  role,
			Parts: []geminiPart{{Text: m.Content}},
		})
	}

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
		return "", fmt.Errorf("gemini API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result geminiResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return "", err
	}
	if len(result.Candidates) == 0 || len(result.Candidates[0].Content.Parts) == 0 {
		return "", errors.New("gemini returned no candidates")
	}

	return result.Candidates[0].Content.Parts[0].Text, nil
}

// ================= Ensemble mode =================

type providerResult struct {
	Provider string
	Answer   string
	Err      error
}

// callEnsemble calls Groq and Mistral in parallel, then asks Groq to
// combine both answers into one final, synthesized answer.
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

	// Get the last user message as the prompt context for synthesis
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
	final, err := callGroq(synthesisHistory) // reuse Groq as the "judge" — it's fast
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

	// 30-second client timeout + context timeout — prevents hanging forever if the AI API is slow
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

func selectProvider(prompt string) string {
	length := len(prompt)

	if length > 300 {
		return "mistral"
	}

	return "groq"
}

// ================= Database =================

var dbPool *pgxpool.Pool

func connectDB() error {
	dbURL := os.Getenv("SUPABASE_DB_URL")
	if dbURL == "" {
		return errors.New("SUPABASE_DB_URL environment variable is not set")
	}

	pool, err := pgxpool.New(context.Background(), dbURL)
	if err != nil {
		return err
	}

	if err := pool.Ping(context.Background()); err != nil {
		return err
	}

	dbPool = pool
	return nil
}

// saveQuery logs one query + its answer into the "queries" table.
// Errors here are logged but never block the response.
func saveQuery(prompt, provider, answer string) {
	if dbPool == nil {
		return
	}

	_, err := dbPool.Exec(context.Background(),
		"insert into queries (prompt, provider, answer) values ($1, $2, $3)",
		prompt, provider, answer,
	)
	if err != nil {
		log.Println("saveQuery error:", err)
	}
}

// ================= /query request/response shape =================

type queryRequest struct {
	// History is the full conversation history for the current provider.
	// Each entry is {role: "user"|"assistant", content: "..."}.
	// The last entry must always be the new user message.
	History  []message `json:"history"`
	Provider string    `json:"provider"`

	// Legacy single-prompt support (used when history is empty)
	Prompt string `json:"prompt"`
}

type queryResponse struct {
	Provider   string            `json:"provider"`
	Answer     string            `json:"answer"`
	RawAnswers map[string]string `json:"raw_answers,omitempty"`
}

// ================= /summarize request/response shape =================
// Called by the frontend when a user switches models mid-conversation.
// The previous model's chat history is condensed into a briefing that
// the new model can absorb before the conversation continues.

type summarizeRequest struct {
	History      []message `json:"history"`
	FromProvider string    `json:"from_provider"`
	ToProvider   string    `json:"to_provider"`
}

type summarizeResponse struct {
	Summary string `json:"summary"`
}

// handleSummarize creates a handoff brief so the new model understands
// what was discussed before it joined the conversation.
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

	// Build a human-readable transcript
	var transcript strings.Builder
	for _, m := range req.History {
		// Capitalize first letter (strings.Title is deprecated)
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

	// Use the target provider to generate its own briefing when possible
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
	default:
		// fallback: use Groq
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

	// Build history: prefer the full history array; fall back to legacy single prompt
	var history []message
	if len(req.History) > 0 {
		history = req.History
	} else if req.Prompt != "" {
		history = []message{{Role: "user", Content: req.Prompt}}
	} else {
		http.Error(w, `"history" or "prompt" field is required`, http.StatusBadRequest)
		return
	}

	// Extract the last user message for DB logging
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
	case "ensemble":
		answer, rawAnswers, err = callEnsemble(history)
	default:
		http.Error(w, fmt.Sprintf(`unknown provider %q — use "groq", "mistral", "chatgpt", "gemini", or "ensemble"`, provider), http.StatusBadRequest)
		return
	}

	if err != nil {
		log.Printf("call%s error: %v", provider, err)
		http.Error(w, fmt.Sprintf("failed to get response from %s: %v", provider, err), http.StatusInternalServerError)
		return
	}

	saveQuery(lastPrompt, provider, answer)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(queryResponse{Provider: provider, Answer: answer, RawAnswers: rawAnswers})
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

	if dbPool == nil {
		http.Error(w, "database not connected", http.StatusServiceUnavailable)
		return
	}

	rows, err := dbPool.Query(context.Background(),
		"select id, prompt, provider, answer, created_at from queries order by created_at desc limit 100",
	)
	if err != nil {
		log.Println("handleHistory query error:", err)
		http.Error(w, "failed to fetch history", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var records []historyRecord
	for rows.Next() {
		var rec historyRecord
		if err := rows.Scan(&rec.ID, &rec.Prompt, &rec.Provider, &rec.Answer, &rec.CreatedAt); err != nil {
			log.Println("handleHistory scan error:", err)
			continue
		}
		records = append(records, rec)
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
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

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
		log.Println("warning: could not connect to database:", err)
		log.Println("server will still run, but queries won't be saved")
	} else {
		log.Println("connected to Supabase")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", enableCORS(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	}))
	mux.HandleFunc("/query", enableCORS(handleQuery))
	mux.HandleFunc("/history", enableCORS(handleHistory))
	mux.HandleFunc("/summarize", enableCORS(handleSummarize))

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  35 * time.Second,
		WriteTimeout: 35 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
	log.Printf("nexus orchestrator-api listening on :%s", port)
	if err := server.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
