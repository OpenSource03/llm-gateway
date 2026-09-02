package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"os/user"
	"syscall"
	"time"

	"github.com/OpenSource03/llm-gateway/addons/codex-auth-bridge/internal/bridge"
)

func main() {
	logger := log.New(os.Stderr, "codex-auth-bridge ", log.LstdFlags|log.LUTC)
	if err := run(logger); err != nil {
		logger.Print(err)
		os.Exit(1)
	}
}

func run(logger *log.Logger) error {
	currentUser, err := user.Current()
	if err != nil {
		return errors.New("could not determine the current macOS user")
	}

	listenAddress := flag.String("listen", bridge.DefaultListenAddress, "loopback listen address")
	upstreamURL := flag.String("upstream", bridge.DefaultUpstreamURL, "fixed LLM Gateway data-plane base URL")
	keychainAccount := flag.String("keychain-account", currentUser.Username, "macOS Keychain account")
	keychainService := flag.String("keychain-service", bridge.DefaultKeychainService, "macOS Keychain service")
	keychainCommand := flag.String("keychain-command", bridge.DefaultKeychainCommand, "absolute macOS security command path")
	flag.Parse()

	config, err := (bridge.Config{
		ListenAddress: *listenAddress,
		UpstreamURL:   *upstreamURL,
	}).Validate()
	if err != nil {
		return err
	}

	credentialContext, cancelCredential := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelCredential()
	gatewayKey, err := (bridge.KeychainCredentialSource{
		Account: *keychainAccount,
		Command: *keychainCommand,
		Service: *keychainService,
	}).Load(credentialContext)
	if err != nil {
		return err
	}

	handler, err := bridge.NewHandler(bridge.HandlerOptions{
		GatewayKey: gatewayKey,
		Logger:     logger,
		Upstream:   config.Upstream,
	})
	if err != nil {
		return err
	}

	listener, err := net.Listen("tcp", config.ListenAddress)
	if err != nil {
		return errors.New("could not bind the configured loopback address")
	}
	defer listener.Close()

	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    64 * 1024,
	}
	shutdownContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serverError := make(chan error, 1)
	go func() {
		logger.Printf("listening on %s", config.ListenAddress)
		serverError <- server.Serve(listener)
	}()

	select {
	case err := <-serverError:
		if !errors.Is(err, http.ErrServerClosed) {
			return errors.New("HTTP server stopped unexpectedly")
		}
	case <-shutdownContext.Done():
		shutdownDeadline, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelShutdown()
		if err := server.Shutdown(shutdownDeadline); err != nil {
			return errors.New("HTTP server shutdown failed")
		}
	}

	logger.Print("stopped")
	return nil
}
