package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
)

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

func main() {
	apiKey := os.Getenv("MISTRAL_API_KEY")
	if apiKey == "" {
		log.Fatal("MISTRAL_API_KEY environment variable is not set")
	}

	reqBody := chatRequest{
		Model: "mistral-small-latest",
		Messages: []message{
			{Role: "user", Content: "Say hello in one short sentence."},
		},
	}

	jsonBody, _ := json.Marshal(reqBody)

	req, _ := http.NewRequest("POST", "https://api.mistral.ai/v1/chat/completions", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		log.Fatal(err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		log.Fatalf("Mistral API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result chatResponse
	json.Unmarshal(body, &result)

	fmt.Println("Mistral AI  says:", result.Choices[0].Message.Content)
}
