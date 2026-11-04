package plugin

import (
	"context"
	"fmt"
	"math"
	"net"
	"net/url"
	"strconv"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/KWDB/kwdb-grafana-plugin/pkg/models"
)

const (
	defaultHost     = "localhost"
	defaultPort     = 26257
	defaultDatabase = "defaultdb"
	defaultUser     = "root"
	defaultSSLMode  = "disable"

	// Connection pool defaults; durations are expressed in seconds.
	defaultPoolMaxConns        = 8
	poolMinConns               = 0
	defaultPoolMaxConnLifetime = 3600 // 1h
	defaultPoolMaxConnIdleTime = 900  // 15min
	defaultPoolConnectTimeout  = 5
	defaultQueryTimeout        = 30 // 30s statement timeout

	// applicationName is reported by KWDB in SHOW SESSIONS / SHOW QUERIES so
	// operators can attribute connections to the Grafana plugin.
	applicationName = "grafana-kwdb-tsdb-datasource"
)

// NewDatasource creates a datasource instance with a KWDB pgx connection pool.
func NewDatasource(ctx context.Context, settings backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
	cfg, secrets, err := models.LoadSettings(settings)
	if err != nil {
		return nil, err
	}
	// Validate first: after applyDefaults a negative value would already have
	// been replaced by a default, so it could no longer be rejected.
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	applyDefaults(cfg)

	poolCfg, err := pgxpool.ParseConfig(buildConnString(*cfg, secrets.Password))
	if err != nil {
		// The connection string contains the password; keep it out of the error
		// shown in the Grafana UI even though pgx is not expected to print it.
		return nil, fmt.Errorf("could not parse pgx connection string: %s", sanitizeMessage(err.Error()))
	}
	// pgxpool.Config.MaxConns is an int32 while the setting is an int. The clamp
	// has to be applied to a local variable: gosec tracks the guard there but
	// not through a struct field, which is why clamping cfg.MaxConns in place
	// still produced a G115 finding. (//nolint:gosec is a golangci-lint
	// directive; gosec itself only honours #nosec, so it did not suppress it.)
	// Validate rejects negative values and applyDefaults replaced zero, so only
	// the upper bound has to be capped here.
	maxConns := cfg.MaxConns
	if maxConns > math.MaxInt32 {
		maxConns = math.MaxInt32
	}
	poolCfg.MaxConns = int32(maxConns)
	poolCfg.MinConns = poolMinConns
	poolCfg.MaxConnLifetime = time.Duration(cfg.MaxConnLifetime) * time.Second
	poolCfg.MaxConnIdleTime = time.Duration(cfg.MaxConnIdleTime) * time.Second
	poolCfg.ConnConfig.ConnectTimeout = time.Duration(cfg.ConnectTimeout) * time.Second
	applySessionSettings(poolCfg, *cfg)

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("could not create pgx connection pool: %w", err)
	}

	return &Datasource{
		pool:         pool,
		handler:      newMetadataHandler(pool, cfg.Database),
		queryTimeout: queryTimeoutDuration(*cfg),
		maxRows:      maxRowsValue(*cfg),
		database:     cfg.Database,
	}, nil
}

// applySessionSettings enforces read-only statements and a statement timeout on
// every pooled connection. Both settings are applied as startup parameters so
// they cannot be bypassed by a query and so the plugin never has to run
// additional statements after connecting.
func applySessionSettings(poolCfg *pgxpool.Config, cfg models.DataSourceSettings) {
	if poolCfg.ConnConfig.RuntimeParams == nil {
		poolCfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	poolCfg.ConnConfig.RuntimeParams["application_name"] = applicationName
	poolCfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	if timeout := queryTimeoutDuration(cfg); timeout > 0 {
		poolCfg.ConnConfig.RuntimeParams["statement_timeout"] = strconv.FormatInt(timeout.Milliseconds(), 10)
	}
}

// queryTimeoutDuration resolves the effective per-query timeout. Zero selects
// the default; a negative value disables the timeout.
func queryTimeoutDuration(cfg models.DataSourceSettings) time.Duration {
	seconds := cfg.QueryTimeout
	if seconds == 0 {
		seconds = defaultQueryTimeout
	}
	if seconds < 0 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}

// maxRowsValue resolves the effective per-frame row cap. Zero selects the
// default; a negative value disables the cap.
func maxRowsValue(cfg models.DataSourceSettings) int {
	if cfg.MaxRows == 0 {
		return DefaultMaxRows
	}
	if cfg.MaxRows < 0 {
		return 0
	}
	return cfg.MaxRows
}

func applyDefaults(cfg *models.DataSourceSettings) {
	if cfg.Host == "" {
		cfg.Host = defaultHost
	}
	if cfg.Port == 0 {
		cfg.Port = defaultPort
	}
	if cfg.Database == "" {
		cfg.Database = defaultDatabase
	}
	if cfg.User == "" {
		cfg.User = defaultUser
	}
	if cfg.SSLMode == "" {
		cfg.SSLMode = defaultSSLMode
	}
	// Zero means "not configured"; negatives were rejected by Validate.
	if cfg.MaxConns == 0 {
		cfg.MaxConns = defaultPoolMaxConns
	}
	if cfg.MaxConnLifetime == 0 {
		cfg.MaxConnLifetime = defaultPoolMaxConnLifetime
	}
	if cfg.MaxConnIdleTime == 0 {
		cfg.MaxConnIdleTime = defaultPoolMaxConnIdleTime
	}
	if cfg.ConnectTimeout == 0 {
		cfg.ConnectTimeout = defaultPoolConnectTimeout
	}
}

func buildConnString(cfg models.DataSourceSettings, password string) string {
	u := url.URL{
		Scheme: "postgresql",
		User:   url.UserPassword(cfg.User, password),
		Host:   net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)),
		Path:   "/" + cfg.Database,
	}
	query := u.Query()
	query.Set("sslmode", cfg.SSLMode)
	if cfg.SSLRootCert != "" {
		query.Set("sslrootcert", cfg.SSLRootCert)
	}
	u.RawQuery = query.Encode()
	return u.String()
}
