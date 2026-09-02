package bridge

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	DefaultKeychainCommand = "/usr/bin/security"
	DefaultKeychainService = "LLM Gateway"
	defaultCredentialLimit = 4096
	defaultCommandTimeout  = 5 * time.Second
)

type commandRunner func(context.Context, string, ...string) ([]byte, error)

type KeychainCredentialSource struct {
	Account string
	Command string
	Service string
	run     commandRunner
}

func (source KeychainCredentialSource) Load(ctx context.Context) (string, error) {
	if !validKeychainSelector(source.Account) || !validKeychainSelector(source.Service) {
		return "", errors.New("keychain account and service must be bounded printable values")
	}

	command := source.Command
	if command == "" {
		command = DefaultKeychainCommand
	}
	if !filepath.IsAbs(command) {
		return "", errors.New("keychain command must use an absolute path")
	}

	timedContext, cancel := context.WithTimeout(ctx, defaultCommandTimeout)
	defer cancel()

	runner := source.run
	if runner == nil {
		runner = func(ctx context.Context, executable string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, executable, args...).Output()
		}
	}

	output, err := runner(
		timedContext,
		command,
		"find-generic-password",
		"-a",
		source.Account,
		"-s",
		source.Service,
		"-w",
	)
	if err != nil {
		return "", errors.New("could not read the gateway key from macOS Keychain")
	}

	credential := strings.TrimRight(string(output), "\r\n")
	if err := validateCredential(credential); err != nil {
		return "", err
	}

	return credential, nil
}

func validKeychainSelector(value string) bool {
	return value != "" && len(value) <= 512 &&
		strings.IndexFunc(value, func(character rune) bool {
			return character < ' ' || character == 0x7f
		}) < 0
}

func validateCredential(credential string) error {
	if credential == "" {
		return errors.New("gateway key is empty")
	}
	if len(credential) > defaultCredentialLimit {
		return errors.New("gateway key exceeds the supported length")
	}
	if strings.IndexFunc(credential, func(character rune) bool {
		return character <= ' ' || character == 0x7f
	}) >= 0 {
		return errors.New("gateway key contains invalid whitespace or control characters")
	}

	return nil
}
