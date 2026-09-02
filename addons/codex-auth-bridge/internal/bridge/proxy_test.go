package bridge

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestProxyReplacesAuthenticationAndPreservesRequest(t *testing.T) {
	type observation struct {
		authorization string
		body          string
		cookie        string
		forwardedFor  string
		host          string
		path          string
		query         string
		xAPIKey       string
	}
	observed := make(chan observation, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read upstream body: %v", err)
		}
		observed <- observation{
			authorization: request.Header.Get("Authorization"),
			body:          string(body),
			cookie:        request.Header.Get("Cookie"),
			forwardedFor:  request.Header.Get("X-Forwarded-For"),
			host:          request.Host,
			path:          request.URL.Path,
			query:         request.URL.RawQuery,
			xAPIKey:       request.Header.Get("X-Api-Key"),
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("Set-Cookie", "must-not-escape=true")
		_, _ = writer.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	handler := newTestHandler(t, upstream.URL+"/api/llm-gateway", upstream.Client().Transport)
	server := httptest.NewServer(handler)
	defer server.Close()

	request, err := http.NewRequest(http.MethodPost, server.URL+"/v1/responses?client_version=1", strings.NewReader(`{"model":"test"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer chatgpt-token-must-not-escape")
	request.Header.Set("Cookie", "session=must-not-escape")
	request.Header.Set("X-Api-Key", "must-not-escape")
	request.Header.Set("X-Forwarded-For", "203.0.113.9")

	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("bridge request failed: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected bridge status: %d", response.StatusCode)
	}
	if response.Header.Get("Set-Cookie") != "" {
		t.Fatal("upstream Set-Cookie escaped the bridge")
	}

	result := <-observed
	if result.authorization != "Bearer llmgw_dat_test" {
		t.Fatalf("unexpected upstream authorization: %q", result.authorization)
	}
	if result.cookie != "" || result.xAPIKey != "" || result.forwardedFor != "" {
		t.Fatalf("sensitive inbound headers escaped: %#v", result)
	}
	if result.path != "/api/llm-gateway/v1/responses" || result.query != "client_version=1" {
		t.Fatalf("unexpected upstream target: %#v", result)
	}
	if result.host != strings.TrimPrefix(upstream.URL, "http://") {
		t.Fatalf("unexpected upstream host: %q", result.host)
	}
	if result.body != `{"model":"test"}` {
		t.Fatalf("request body changed: %q", result.body)
	}
}

func TestProxyStreamsWithoutBuffering(t *testing.T) {
	releaseSecondEvent := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		flusher, ok := writer.(http.Flusher)
		if !ok {
			t.Fatal("test server does not support flushing")
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(writer, "event: first\ndata: one\n\n")
		flusher.Flush()
		<-releaseSecondEvent
		_, _ = io.WriteString(writer, "event: second\ndata: two\n\n")
		flusher.Flush()
	}))
	defer upstream.Close()

	server := httptest.NewServer(newTestHandler(t, upstream.URL, upstream.Client().Transport))
	defer server.Close()
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/responses", strings.NewReader("{}"))
	request.Header.Set("Authorization", "Bearer chatgpt-token")

	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("stream request failed: %v", err)
	}
	defer response.Body.Close()
	firstEvent := make(chan string, 1)
	go func() {
		reader := bufio.NewReader(response.Body)
		firstEvent <- readSSEFrame(reader)
	}()

	select {
	case event := <-firstEvent:
		if event != "event: first\ndata: one\n\n" {
			t.Fatalf("unexpected first event: %q", event)
		}
	case <-time.After(time.Second):
		t.Fatal("bridge buffered the first SSE event")
	}
	close(releaseSecondEvent)
}

func TestProxyPropagatesCancellation(t *testing.T) {
	upstreamCancelled := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(writer, ": ready\n\n")
		writer.(http.Flusher).Flush()
		<-request.Context().Done()
		close(upstreamCancelled)
	}))
	defer upstream.Close()

	server := httptest.NewServer(newTestHandler(t, upstream.URL, upstream.Client().Transport))
	defer server.Close()
	requestContext, cancelRequest := context.WithCancel(context.Background())
	request, _ := http.NewRequestWithContext(requestContext, http.MethodPost, server.URL+"/v1/responses", strings.NewReader("{}"))
	request.Header.Set("Authorization", "Bearer chatgpt-token")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("stream request failed: %v", err)
	}

	buffer := make([]byte, len(": ready\n\n"))
	if _, err := io.ReadFull(response.Body, buffer); err != nil {
		t.Fatalf("read first stream frame: %v", err)
	}
	cancelRequest()
	_ = response.Body.Close()

	select {
	case <-upstreamCancelled:
	case <-time.After(time.Second):
		t.Fatal("downstream cancellation did not reach the upstream")
	}
}

func TestProxyRejectsUnauthenticatedAndUnsafeRequests(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		upstreamCalls.Add(1)
	}))
	defer upstream.Close()
	handler := newTestHandler(t, upstream.URL, upstream.Client().Transport)

	tests := []struct {
		name       string
		path       string
		remoteAddr string
		auth       string
		status     int
	}{
		{name: "missing auth", path: "/v1/models", remoteAddr: "127.0.0.1:40000", status: http.StatusUnauthorized},
		{name: "path traversal", path: "/v1/../admin/v1/accounts", remoteAddr: "127.0.0.1:40000", auth: "Bearer token", status: http.StatusNotFound},
		{name: "encoded path traversal", path: "/v1/%2e%2e/admin/v1/accounts", remoteAddr: "127.0.0.1:40000", auth: "Bearer token", status: http.StatusNotFound},
		{name: "remote client", path: "/v1/models", remoteAddr: "192.0.2.1:40000", auth: "Bearer token", status: http.StatusForbidden},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "http://bridge"+test.path, nil)
			request.RemoteAddr = test.remoteAddr
			if test.auth != "" {
				request.Header.Set("Authorization", test.auth)
			}
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("unexpected status: got %d, want %d", response.Code, test.status)
			}
		})
	}
	if upstreamCalls.Load() != 0 {
		t.Fatalf("rejected requests reached upstream %d times", upstreamCalls.Load())
	}
}

func TestHealthEndpointRequiresNoCredential(t *testing.T) {
	upstream, _ := url.Parse("http://127.0.0.1:3001")
	handler, err := NewHandler(HandlerOptions{GatewayKey: "llmgw_dat_test", Upstream: upstream})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://bridge"+HealthPath, nil)
	request.RemoteAddr = "127.0.0.1:40000"
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"ready"`) {
		t.Fatalf("unexpected health response: %d %s", response.Code, response.Body.String())
	}
}

func TestProxyErrorIsSanitized(t *testing.T) {
	var logs bytes.Buffer
	upstream, _ := url.Parse("https://gateway.example.test")
	handler, err := NewHandler(HandlerOptions{
		GatewayKey: "llmgw_dat_test",
		Logger:     log.New(&logs, "", 0),
		Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("secret upstream diagnostic")
		}),
		Upstream: upstream,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://bridge/v1/models", nil)
	request.RemoteAddr = "127.0.0.1:40000"
	request.Header.Set("Authorization", "Bearer chatgpt-secret")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("unexpected status: %d", response.Code)
	}
	if strings.Contains(logs.String(), "secret") || strings.Contains(response.Body.String(), "secret") {
		t.Fatal("proxy error leaked upstream or credential details")
	}
}

func TestProxyDoesNotLogDownstreamCancellation(t *testing.T) {
	var logs bytes.Buffer
	upstream, _ := url.Parse("https://gateway.example.test")
	handler, err := NewHandler(HandlerOptions{
		GatewayKey: "llmgw_dat_test",
		Logger:     log.New(&logs, "", 0),
		Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
			return nil, request.Context().Err()
		}),
		Upstream: upstream,
	})
	if err != nil {
		t.Fatal(err)
	}
	requestContext, cancelRequest := context.WithCancel(context.Background())
	cancelRequest()
	request := httptest.NewRequest(http.MethodGet, "http://bridge/v1/models", nil).WithContext(requestContext)
	request.RemoteAddr = "127.0.0.1:40000"
	request.Header.Set("Authorization", "Bearer chatgpt-secret")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if logs.Len() != 0 {
		t.Fatalf("downstream cancellation produced a misleading error log: %q", logs.String())
	}
}

func newTestHandler(t *testing.T, upstreamURL string, transport http.RoundTripper) http.Handler {
	t.Helper()
	upstream, err := url.Parse(upstreamURL)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandler(HandlerOptions{
		GatewayKey: "llmgw_dat_test",
		Transport:  transport,
		Upstream:   upstream,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func readSSEFrame(reader *bufio.Reader) string {
	var frame strings.Builder
	for {
		line, err := reader.ReadString('\n')
		frame.WriteString(line)
		if err != nil || strings.HasSuffix(frame.String(), "\n\n") {
			return frame.String()
		}
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (function roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
