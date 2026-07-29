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
// Groq, Mistral, and OpenAI all use the same OpenAI-style chat completion
// shape, so we can reuse one set of types for all three providers.

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

func callGroq(prompt string) (string, error) {
	apiKey := os.Getenv("GROQ_API_KEY")
	if apiKey == "" {
		return "", errors.New("GROQ_API_KEY environment variable is not set")
	}

	reqBody := chatRequest{
		Model: "llama-3.3-70b-versatile",
		Messages: []message{
			{Role: "user", Content: prompt},
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	return sendChatRequest(ctx, "https://api.groq.com/openai/v1/chat/completions", apiKey, reqBody, "groq")
}

// ================= Mistral adapter =================

func callMistral(prompt string) (string, error) {
	apiKey := os.Getenv("MISTRAL_API_KEY")
	if apiKey == "" {
		return "", errors.New("MISTRAL_API_KEY environment variable is not set")
	}

	reqBody := chatRequest{
		Model: "mistral-small-latest",
		Messages: []message{
			{Role: "user", Content: prompt},
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	return sendChatRequest(ctx, "https://api.mistral.ai/v1/chat/completions", apiKey, reqBody, "mistral")
}

// ================= OpenAI (ChatGPT) adapter =================

func callOpenAI(prompt string) (string, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return "", errors.New("OPENAI_API_KEY environment variable is not set")
	}

	reqBody := chatRequest{
		Model: "gpt-4o-mini", // cost-effective; swap to "gpt-4o" for higher quality
		Messages: []message{
			{Role: "user", Content: prompt},
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	return sendChatRequest(ctx, "https://api.openai.com/v1/chat/completions", apiKey, reqBody, "chatgpt")
}

// ================= Ensemble mode =================

type providerResult struct {
	Provider string
	Answer   string
	Err      error
}

// callEnsemble calls Groq and Mistral in parallel, then asks Groq to
// combine both answers into one final, synthesized answer.
func callEnsemble(prompt string) (string, map[string]string, error) {
	results := make([]providerResult, 2)
	var wg sync.WaitGroup

	wg.Add(2)
	go func() {
		defer wg.Done()
		answer, err := callGroq(prompt)
		results[0] = providerResult{Provider: "groq", Answer: answer, Err: err}
	}()
	go func() {
		defer wg.Done()
		answer, err := callMistral(prompt)
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

	synthesisPrompt := fmt.Sprintf(
		"Here are answers from two different AI models to the same question: %q\n\n%s\n\nCombine them into one clear, best final answer. Just give the answer, no commentary about the models.",
		prompt, strings.Join(validAnswers, "\n"),
	)

	final, err := callGroq(synthesisPrompt) // reuse Groq as the "judge" — it's fast
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
	Prompt   string `json:"prompt"`
	Provider string `json:"provider"`
}

type queryResponse struct {
	Provider   string            `json:"provider"`
	Answer     string            `json:"answer"`
	RawAnswers map[string]string `json:"raw_answers,omitempty"`
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
	if req.Prompt == "" {
		http.Error(w, `"prompt" field is required`, http.StatusBadRequest)
		return
	}

	provider := req.Provider
	if provider == "" || provider == "auto" {
		provider = selectProvider(req.Prompt)
	}

	var answer string
	var rawAnswers map[string]string
	var err error

	switch provider {
	case "groq":
		answer, err = callGroq(req.Prompt)
	case "mistral":
		answer, err = callMistral(req.Prompt)
	case "chatgpt":
		answer, err = callOpenAI(req.Prompt)
	case "ensemble":
		answer, rawAnswers, err = callEnsemble(req.Prompt)
	default:
		http.Error(w, fmt.Sprintf(`unknown provider %q — use "groq", "mistral", "chatgpt", or "ensemble"`, provider), http.StatusBadRequest)
		return
	}

	if err != nil {
		log.Printf("call%s error: %v", provider, err)
		http.Error(w, fmt.Sprintf("failed to get response from %s: %v", provider, err), http.StatusInternalServerError)
		return
	}

	saveQuery(req.Prompt, provider, answer)

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
