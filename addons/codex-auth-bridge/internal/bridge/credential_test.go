package bridge

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestKeychainCredentialSource(t *testing.T) {
	var command string
	var arguments []string
	source := KeychainCredentialSource{
		Account: "mac-user",
		Command: "/usr/bin/security",
		Service: "Test Gateway",
		run: func(_ context.Context, executable string, args ...string) ([]byte, error) {
			command = executable
			arguments = append([]string(nil), args...)
			return []byte("llmgw_dat_test-value\n"), nil
		},
	}

	credential, err := source.Load(context.Background())
	if err != nil {
		t.Fatalf("unexpected credential error: %v", err)
	}
	if credential != "llmgw_dat_test-value" {
		t.Fatalf("unexpected credential value: %q", credential)
	}
	if command != "/usr/bin/security" {
		t.Fatalf("unexpected command: %q", command)
	}
	wantArguments := []string{
		"find-generic-password",
		"-a",
		"mac-user",
		"-s",
		"Test Gateway",
		"-w",
	}
	if !reflect.DeepEqual(arguments, wantArguments) {
		t.Fatalf("unexpected command arguments: %#v", arguments)
	}
}

func TestKeychainCredentialErrorsAreSanitized(t *testing.T) {
	source := KeychainCredentialSource{
		Account: "mac-user",
		Service: "Test Gateway",
		run: func(context.Context, string, ...string) ([]byte, error) {
			return []byte("secret diagnostic output"), errors.New("secret command failure")
		},
	}

	_, err := source.Load(context.Background())
	if err == nil {
		t.Fatal("expected credential error")
	}
	if strings.Contains(err.Error(), "secret") {
		t.Fatalf("credential error leaked command details: %q", err)
	}
}

func TestKeychainCredentialRejectsUnsafeOutput(t *testing.T) {
	source := KeychainCredentialSource{
		Account: "mac-user",
		Service: "Test Gateway",
		run: func(context.Context, string, ...string) ([]byte, error) {
			return []byte("invalid key value\n"), nil
		},
	}

	if _, err := source.Load(context.Background()); err == nil {
		t.Fatal("expected unsafe credential to be rejected")
	}
}

func TestKeychainCredentialRequiresAbsoluteCommand(t *testing.T) {
	source := KeychainCredentialSource{
		Account: "mac-user",
		Command: "security",
		Service: "Test Gateway",
	}

	if _, err := source.Load(context.Background()); err == nil {
		t.Fatal("expected a relative keychain command to be rejected")
	}
}
