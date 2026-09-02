package bridge

import (
	"fmt"
	"net"
	"net/url"
	"path"
	"strconv"
	"strings"
)

const (
	DefaultListenAddress = "127.0.0.1:43817"
	DefaultUpstreamURL   = "http://127.0.0.1:3001/api/llm-gateway"
)

type Config struct {
	ListenAddress string
	UpstreamURL   string
}

type ValidatedConfig struct {
	ListenAddress string
	Upstream      *url.URL
}

func (config Config) Validate() (ValidatedConfig, error) {
	if err := validateListenAddress(config.ListenAddress); err != nil {
		return ValidatedConfig{}, err
	}

	upstream, err := validateUpstream(config.UpstreamURL)
	if err != nil {
		return ValidatedConfig{}, err
	}

	return ValidatedConfig{
		ListenAddress: config.ListenAddress,
		Upstream:      upstream,
	}, nil
}

func validateListenAddress(address string) error {
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid listen address: %w", err)
	}

	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("listen address must use a loopback IP")
	}

	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("listen address must contain a valid non-zero port")
	}

	return nil
}

func validateUpstream(raw string) (*url.URL, error) {
	upstream, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid upstream URL: %w", err)
	}

	if upstream.Scheme != "http" && upstream.Scheme != "https" {
		return nil, fmt.Errorf("upstream URL must use HTTP or HTTPS")
	}
	if upstream.Host == "" || upstream.User != nil {
		return nil, fmt.Errorf("upstream URL must contain a host and no user info")
	}
	if upstream.Fragment != "" || upstream.RawQuery != "" {
		return nil, fmt.Errorf("upstream URL cannot contain a query or fragment")
	}
	if upstream.Scheme == "http" && !isLoopbackHost(upstream.Hostname()) {
		return nil, fmt.Errorf("non-loopback upstream URLs must use HTTPS")
	}

	decodedPath, err := url.PathUnescape(upstream.EscapedPath())
	if err != nil {
		return nil, fmt.Errorf("upstream URL path must be canonical")
	}
	if decodedPath == "" {
		decodedPath = "/"
	}
	if path.Clean(decodedPath) != decodedPath {
		return nil, fmt.Errorf("upstream URL path must be canonical")
	}
	upstream.Path = strings.TrimSuffix(decodedPath, "/")
	upstream.RawPath = ""

	return upstream, nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}

	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
