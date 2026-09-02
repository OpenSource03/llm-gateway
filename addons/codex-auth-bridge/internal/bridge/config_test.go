package bridge

import "testing"

func TestConfigValidation(t *testing.T) {
	tests := []struct {
		name    string
		config  Config
		wantErr bool
	}{
		{
			name: "loopback HTTP upstream",
			config: Config{
				ListenAddress: "127.0.0.1:43817",
				UpstreamURL:   "http://127.0.0.1:3001/api/llm-gateway",
			},
		},
		{
			name: "remote HTTPS upstream",
			config: Config{
				ListenAddress: "[::1]:43817",
				UpstreamURL:   "https://gateway.example.test",
			},
		},
		{
			name: "public listener",
			config: Config{
				ListenAddress: "0.0.0.0:43817",
				UpstreamURL:   "https://gateway.example.test",
			},
			wantErr: true,
		},
		{
			name: "remote plaintext upstream",
			config: Config{
				ListenAddress: "127.0.0.1:43817",
				UpstreamURL:   "http://gateway.example.test",
			},
			wantErr: true,
		},
		{
			name: "upstream credentials",
			config: Config{
				ListenAddress: "127.0.0.1:43817",
				UpstreamURL:   "https://user:password@gateway.example.test",
			},
			wantErr: true,
		},
		{
			name: "upstream query",
			config: Config{
				ListenAddress: "127.0.0.1:43817",
				UpstreamURL:   "https://gateway.example.test?target=other",
			},
			wantErr: true,
		},
		{
			name: "noncanonical upstream path",
			config: Config{
				ListenAddress: "127.0.0.1:43817",
				UpstreamURL:   "https://gateway.example.test/data/../control",
			},
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			validated, err := test.config.Validate()
			if test.wantErr {
				if err == nil {
					t.Fatalf("expected validation error, got %#v", validated)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected validation error: %v", err)
			}
			if validated.ListenAddress != test.config.ListenAddress {
				t.Fatalf("listen address changed: %q", validated.ListenAddress)
			}
		})
	}
}
