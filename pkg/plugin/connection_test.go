package plugin

import (
	"context"
	"strings"
	"testing"

	"github.com/KWDB/kwdb-grafana-plugin/pkg/models"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func TestApplyDefaults(t *testing.T) {
	cfg := models.DataSourceSettings{}
	applyDefaults(&cfg)

	if cfg.Host != defaultHost {
		t.Errorf("Host = %q, want %q", cfg.Host, defaultHost)
	}
	if cfg.Port != defaultPort {
		t.Errorf("Port = %d, want %d", cfg.Port, defaultPort)
	}
	if cfg.Database != defaultDatabase {
		t.Errorf("Database = %q, want %q", cfg.Database, defaultDatabase)
	}
	if cfg.User != defaultUser {
		t.Errorf("User = %q, want %q", cfg.User, defaultUser)
	}
	if cfg.SSLMode != defaultSSLMode {
		t.Errorf("SSLMode = %q, want %q", cfg.SSLMode, defaultSSLMode)
	}
}

func TestApplyDefaultsKeepsProvidedValues(t *testing.T) {
	cfg := models.DataSourceSettings{
		Host:     "10.0.0.1",
		Port:     26258,
		Database: "ts_db",
		User:     "reader",
		SSLMode:  "require",
	}
	applyDefaults(&cfg)

	if cfg.Host != "10.0.0.1" || cfg.Port != 26258 || cfg.Database != "ts_db" ||
		cfg.User != "reader" || cfg.SSLMode != "require" {
		t.Errorf("applyDefaults overwrote provided values: %#v", cfg)
	}
}

func TestBuildConnString(t *testing.T) {
	cfg := models.DataSourceSettings{
		Host:     "db.example.com",
		Port:     26258,
		Database: "ts_db",
		User:     "root",
		SSLMode:  "disable",
	}
	dsn := buildConnString(cfg, "secret")

	for _, want := range []string{"postgresql://root:secret@db.example.com:26258/ts_db", "sslmode=disable"} {
		if !strings.Contains(dsn, want) {
			t.Errorf("DSN %q does not contain %q", dsn, want)
		}
	}
}

func TestBuildConnStringIncludesSSLRootCert(t *testing.T) {
	cfg := models.DataSourceSettings{
		Host:        "db.example.com",
		Port:        26257,
		Database:    "ts_db",
		User:        "root",
		SSLMode:     "verify-ca",
		SSLRootCert: "/etc/certs/ca.pem",
	}
	dsn := buildConnString(cfg, "secret")
	if !strings.Contains(dsn, "sslrootcert=%2Fetc%2Fcerts%2Fca.pem") {
		t.Errorf("DSN %q does not contain encoded sslrootcert", dsn)
	}
}

// TestNewDatasourceRejectsInvalidSettings exercises the production creation
// path: validation runs before applyDefaults, so the invalid value reaches
// Validate and is reported instead of being silently replaced by a default.
// No connection is attempted, so an unreachable host is fine here.
func TestNewDatasourceRejectsInvalidSettings(t *testing.T) {
	tests := []struct {
		name    string
		json    string
		wantErr string
	}{
		{
			name:    "negative max connections",
			json:    `{"host":"127.0.0.1","port":1,"database":"db","user":"root","sslMode":"disable","maxConns":-1}`,
			wantErr: "maxConns must not be negative",
		},
		{
			name:    "negative connect timeout",
			json:    `{"host":"127.0.0.1","port":1,"database":"db","user":"root","sslMode":"disable","connectTimeout":-1}`,
			wantErr: "connectTimeout must not be negative",
		},
		{
			name:    "legacy sslmode prefer",
			json:    `{"host":"127.0.0.1","port":1,"database":"db","user":"root","sslMode":"prefer"}`,
			wantErr: "unsupported sslMode",
		},
		{
			name:    "port out of range",
			json:    `{"host":"127.0.0.1","port":70000,"database":"db","user":"root","sslMode":"disable"}`,
			wantErr: "port must be between 1 and 65535",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := NewDatasource(context.Background(), backend.DataSourceInstanceSettings{
				JSONData:                []byte(tt.json),
				DecryptedSecureJSONData: map[string]string{"password": "secret"},
			})
			if err == nil {
				t.Fatalf("NewDatasource() = nil error, want one containing %q", tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("NewDatasource() error = %q, want it to contain %q", err.Error(), tt.wantErr)
			}
			if strings.Contains(err.Error(), "secret") {
				t.Fatalf("NewDatasource() error leaked the password: %q", err.Error())
			}
		})
	}
}

// TestNewDatasourceAcceptsZeroValues checks that zero settings reach
// applyDefaults instead of being rejected: creation cannot be asserted to
// succeed without a server (the pool is lazy), but no validation error may be
// returned for zero values.
func TestNewDatasourceAcceptsZeroValues(t *testing.T) {
	inst, err := NewDatasource(context.Background(), backend.DataSourceInstanceSettings{
		JSONData:                []byte(`{}`),
		DecryptedSecureJSONData: map[string]string{},
	})
	if err != nil {
		t.Fatalf("NewDatasource() rejected zero-value settings: %v", err)
	}
	if d, ok := inst.(*Datasource); ok {
		d.Dispose()
	}
}
