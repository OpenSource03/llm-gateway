package bridge

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"strings"
	"time"
)

const HealthPath = "/_llmgw/health"

type HandlerOptions struct {
	GatewayKey string
	Logger     *log.Logger
	Transport  http.RoundTripper
	Upstream   *url.URL
}

type Handler struct {
	proxy *httputil.ReverseProxy
}

func NewHandler(options HandlerOptions) (*Handler, error) {
	if options.Upstream == nil {
		return nil, errors.New("upstream URL is required")
	}
	if err := validateCredential(options.GatewayKey); err != nil {
		return nil, err
	}

	logger := options.Logger
	if logger == nil {
		logger = log.New(io.Discard, "", 0)
	}
	transport := options.Transport
	if transport == nil {
		transport = newTransport()
	}

	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(options.Upstream)
			request.Out.Host = options.Upstream.Host
			request.Out.Header.Del("Cookie")
			request.Out.Header.Del("Proxy-Authorization")
			request.Out.Header.Del("X-Api-Key")
			request.Out.Header.Set("Authorization", "Bearer "+options.GatewayKey)
		},
		Transport:     transport,
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		ErrorHandler: func(writer http.ResponseWriter, request *http.Request, _ error) {
			if request.Context().Err() != nil {
				return
			}
			logger.Print("upstream request failed")
			writeError(writer, http.StatusBadGateway, "server_error", "Gateway is unavailable")
		},
		ModifyResponse: func(response *http.Response) error {
			response.Header.Del("Set-Cookie")
			return nil
		},
	}

	return &Handler{proxy: proxy}, nil
}

func (handler *Handler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if !isLoopbackRemoteAddress(request.RemoteAddr) {
		writeError(writer, http.StatusForbidden, "permission_error", "Loopback access required")
		return
	}

	if request.URL.Path == HealthPath {
		writeJSON(writer, http.StatusOK, map[string]string{"status": "ready"})
		return
	}
	if !isSafeDataPath(request.URL) {
		writeError(writer, http.StatusNotFound, "invalid_request_error", "Not found")
		return
	}
	if !hasBearerCredential(request.Header.Get("Authorization")) {
		writer.Header().Set("WWW-Authenticate", `Bearer realm="codex-auth-bridge"`)
		writeError(writer, http.StatusUnauthorized, "authentication_error", "ChatGPT authentication required")
		return
	}

	// The OpenAI credential exists only to keep Codex account features active.
	// Remove it before ReverseProxy clones the request; only the gateway key is
	// allowed to cross the loopback trust boundary.
	request.Header.Del("Authorization")
	handler.proxy.ServeHTTP(writer, request)
}

func newTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          16,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 2 * time.Minute,
		ExpectContinueTimeout: time.Second,
		DisableCompression:    true,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
	}
}

func isLoopbackRemoteAddress(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}

	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isSafeDataPath(target *url.URL) bool {
	decoded, err := url.PathUnescape(target.EscapedPath())
	if err != nil || !strings.HasPrefix(decoded, "/v1/") {
		return false
	}
	if strings.Contains(decoded, "\\") || path.Clean(decoded) != decoded {
		return false
	}

	return true
}

func hasBearerCredential(value string) bool {
	const prefix = "Bearer "

	if len(value) <= len(prefix) || len(value) > 16*1024 {
		return false
	}
	if !strings.EqualFold(value[:len(prefix)], prefix) {
		return false
	}

	credential := value[len(prefix):]
	return strings.TrimSpace(credential) == credential &&
		strings.IndexFunc(credential, func(character rune) bool {
			return character <= ' ' || character == 0x7f
		}) < 0
}

func writeError(writer http.ResponseWriter, status int, errorType string, message string) {
	writeJSON(writer, status, map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    errorType,
			"code":    nil,
			"param":   nil,
		},
	})
}

func writeJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}
