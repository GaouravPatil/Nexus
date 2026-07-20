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

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

// ================= Shared message/response shapes =================
// Groq and Mistral both use this exact same OpenAI-style shape, so we
// can reuse one set of types for both providers.

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

	return sendChatRequest("https://api.groq.com/openai/v1/chat/completions", apiKey, reqBody, "groq")
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

	return sendChatRequest("https://api.mistral.ai/v1/chat/completions", apiKey, reqBody, "mistral")
}

// ================= Shared HTTP call logic =================

func sendChatRequest(url, apiKey string, reqBody chatRequest, providerName string) (string, error) {
	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonBody))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{}
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
	Provider string `json:"provider"`
	Answer   string `json:"answer"`
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
	var err error

	switch provider {
	case "groq":
		answer, err = callGroq(req.Prompt)
	case "mistral":
		answer, err = callMistral(req.Prompt)
	default:
		http.Error(w, fmt.Sprintf(`unknown provider %q — use "groq" or "mistral"`, provider), http.StatusBadRequest)
		return
	}

	if err != nil {
		log.Printf("call%s error: %v", provider, err)
		http.Error(w, fmt.Sprintf("failed to get response from %s", provider), http.StatusInternalServerError)
		return
	}

	saveQuery(req.Prompt, provider, answer)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(queryResponse{Provider: provider, Answer: answer})
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
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/query", handleQuery)

	log.Printf("nexus orchestrator-api listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}
