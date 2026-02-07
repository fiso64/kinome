package main

import (
	"bufio"
	"encoding/base64"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		return
	}

	uri := os.Args[1]
	setupLogging()

	log.Printf("--------------------------------------------------")
	log.Printf("Handler invoked with URI: %s", uri)

	if !strings.HasPrefix(uri, "kinome://") {
		log.Printf("ERROR: Invalid protocol (expected kinome://)")
		return
	}

	// Parse the URI
	u, err := url.Parse(uri)
	if err != nil {
		log.Printf("ERROR: Failed to parse URI: %v", err)
		return
	}

	// Normalize path (handle kinome://run? and kinome://run/?)
	action := strings.Trim(u.Host, "/")
	if action == "" {
		// If URI is like kinome:///run?
		action = strings.Trim(u.Path, "/")
	}
	queryParams := u.Query()
	secret := queryParams.Get("secret")

	if !validateSecret(secret) {
		log.Printf("ERROR: Secret validation failed")
		return
	}

	log.Printf("Secret validated. Action: %s", action)

	switch action {
	case "run":
		handleRun(queryParams.Get("command"))
	case "test":
		handleTest(queryParams.Get("url"))
	default:
		log.Printf("ERROR: Unknown action: %s", action)
	}
}

func setupLogging() {
	configDir, err := getConfigDir()
	if err != nil {
		return
	}

	if _, err := os.Stat(configDir); os.IsNotExist(err) {
		os.MkdirAll(configDir, 0755)
	}

	logFile, err := os.OpenFile(filepath.Join(configDir, "handler.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err == nil {
		log.SetOutput(logFile)
	}
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)
}

func getConfigDir() (string, error) {
	userConfig, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(userConfig, "Kinome", "handler"), nil
}

func validateSecret(providedSecret string) bool {
	if providedSecret == "" {
		return false
	}

	configDir, err := getConfigDir()
	if err != nil {
		return false
	}

	confFile := filepath.Join(configDir, "handler.conf")
	file, err := os.Open(confFile)
	if err != nil {
		log.Printf("ERROR: Could not open handler.conf: %v", err)
		return false
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		// Strip UTF-8 BOM if present
		line = strings.TrimPrefix(line, "\xef\xbb\xbf")
		line = strings.TrimSpace(line)

		if line == providedSecret {
			return true
		}
	}
	return false
}

func handleRun(encodedCommand string) {
	if encodedCommand == "" {
		log.Printf("ERROR: Missing command parameter")
		return
	}

	decoded, err := base64.StdEncoding.DecodeString(encodedCommand)
	if err != nil {
		log.Printf("ERROR: Failed to decode command: %v", err)
		return
	}

	commandString := string(decoded)
	log.Printf("Executing: %s", maskToken(commandString))

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		// On Windows, we use 'cmd /c' to allow it to handle quoted executables and arguments correctly.
		// We set HideWindow: true to prevent a terminal window from flashing.
		cmd = exec.Command("cmd", "/c", commandString)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	} else {
		// On Unix, we might need 'sh -c'
		cmd = exec.Command("sh", "-c", commandString)
	}

	err = cmd.Start()
	if err != nil {
		log.Printf("ERROR: Failed to spawn process: %v", err)
		return
	}
	log.Printf("Command spawned successfully")
}

func handleTest(encodedUrl string) {
	if encodedUrl == "" {
		log.Printf("ERROR: Missing url parameter")
		return
	}

	decoded, err := base64.StdEncoding.DecodeString(encodedUrl)
	if err != nil {
		log.Printf("ERROR: Failed to decode handshake URL: %v", err)
		return
	}

	handshakeUrl := string(decoded)
	log.Printf("Pinging handshake URL: %s", handshakeUrl)

	client := http.Client{
		Timeout: 5 * time.Second,
	}

	maxRetries := 5
	backoff := 1 * time.Second

	for i := 0; i < maxRetries; i++ {
		resp, err := client.Get(handshakeUrl)
		if err == nil {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				log.Printf("Handshake successful")
				return
			}
			log.Printf("Handshake attempt %d failed with HTTP %d", i+1, resp.StatusCode)
		} else {
			log.Printf("Handshake attempt %d failed: %v", i+1, err)
		}

		if i < maxRetries-1 {
			log.Printf("Retrying in %v...", backoff)
			time.Sleep(backoff)
			backoff *= 2
		}
	}

	log.Printf("ERROR: Handshake failed after %d attempts", maxRetries)
}

func maskToken(s string) string {
	// Simple mask for token=xyz sequences
	// Matches 'token=' followed by 3 chars, then more chars until & or end of string
	// Replaces the middle part with '***'
	re := regexp.MustCompile(`(token=)([^&]{3})[^&]*([^&]{3})`)
	return re.ReplaceAllString(s, `$1$2***$3`)
}
