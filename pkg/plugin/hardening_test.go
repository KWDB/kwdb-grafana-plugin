package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/KWDB/kwdb-grafana-plugin/pkg/models"
)

// TestIsReadOnlyRejectsLexicalBypasses covers the escape sequences that made the
// previous scanner treat a multi-statement SQL as read-only.
func TestIsReadOnlyRejectsLexicalBypasses(t *testing.T) {
	tests := []struct {
		name string
		sql  string
		want bool
	}{
		{name: "e-string hides multi statement", sql: `SELECT E'\''; DROP TABLE t; --'`, want: false},
		{name: "e-string hides dml in cte", sql: `WITH x AS (SELECT E'\'' ) DELETE FROM t`, want: false},
		{name: "standard string with backslash stays readable", sql: `SELECT 'a\' FROM t`, want: true},
		{name: "standard string cannot hide multi statement", sql: `SELECT 'a\'; DROP TABLE t; --'`, want: false},
		{name: "dollar quoted semicolon is allowed", sql: `SELECT $$a;b$$`, want: true},
		{name: "dollar quoted keyword is allowed", sql: `SELECT $$DROP TABLE t$$`, want: true},
		{name: "tagged dollar quote is allowed", sql: `SELECT $tag$ ; DROP TABLE t $tag$`, want: true},
		{name: "nested block comment is allowed", sql: `SELECT 1 /* a /* b */ ; DROP TABLE t */`, want: true},
		{name: "comment cannot hide second statement", sql: `SELECT 1 /* ; */ ; DROP TABLE t`, want: false},
		{name: "string references internal function", sql: `SELECT * FROM t WHERE note = 'kwdb_internal.force_log_fatal'`, want: true},
		{name: "internal catalog function", sql: `SELECT kwdb_internal.force_log_fatal('boom')`, want: false},
		{name: "internal catalog vmodule", sql: `SELECT kwdb_internal.set_vmodule('recordio=2')`, want: false},
		{name: "sleep function", sql: `SELECT pg_sleep(86400)`, want: false},
		{name: "catalog qualified sleep", sql: `SELECT pg_catalog.pg_sleep(10)`, want: false},
		{name: "server file read", sql: `SELECT pg_read_file('/etc/passwd')`, want: false},
		{name: "sequence advance", sql: `SELECT nextval('some_seq')`, want: false},
		{name: "session config override", sql: `SELECT set_config('statement_timeout', '0', false)`, want: false},
		{name: "show tables", sql: `SHOW TABLES`, want: true},
		{name: "show create table", sql: `SHOW CREATE TABLE "db"."t"`, want: true},
		{name: "show sessions", sql: `SHOW SESSIONS`, want: false},
		{name: "show queries", sql: `SHOW QUERIES`, want: false},
		{name: "show jobs", sql: `SHOW JOBS`, want: false},
		{name: "show session variables", sql: `SHOW statement_timeout`, want: true},
		{name: "show read only variable", sql: `SHOW default_transaction_read_only`, want: true},
		{name: "parameter placeholder", sql: `SELECT * FROM t WHERE a = $1`, want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsReadOnly(tt.sql); got != tt.want {
				t.Errorf("IsReadOnly(%q) = %v, want %v (reason: %s)", tt.sql, got, tt.want, ReadOnlyViolation(tt.sql))
			}
		})
	}
}

func TestReadOnlyViolationExplainsRejection(t *testing.T) {
	if got := ReadOnlyViolation("SELECT 1"); got != "" {
		t.Fatalf("ReadOnlyViolation() = %q, want empty", got)
	}
	for _, sql := range []string{"DELETE FROM t", "SELECT kwdb_internal.force_log_fatal('x')", "SHOW SESSIONS", "SELECT 1; SELECT 2"} {
		if got := ReadOnlyViolation(sql); got == "" {
			t.Errorf("ReadOnlyViolation(%q) = empty, want a reason", sql)
		}
	}
}

// TestApplySessionSettingsEnforcesReadOnly asserts the connection-level guard
// rail that backs up the lexical check.
func TestApplySessionSettingsEnforcesReadOnly(t *testing.T) {
	poolCfg, err := pgxpool.ParseConfig("postgres://user:secret@localhost:26257/db?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	applySessionSettings(poolCfg, models.DataSourceSettings{QueryTimeout: 45})

	if got := poolCfg.ConnConfig.RuntimeParams["default_transaction_read_only"]; got != "on" {
		t.Errorf("default_transaction_read_only = %q, want on", got)
	}
	if got := poolCfg.ConnConfig.RuntimeParams["statement_timeout"]; got != "45000" {
		t.Errorf("statement_timeout = %q, want 45000", got)
	}
	if got := poolCfg.ConnConfig.RuntimeParams["application_name"]; got != applicationName {
		t.Errorf("application_name = %q, want %q", got, applicationName)
	}
}

func TestQueryTimeoutAndMaxRowsDefaults(t *testing.T) {
	if got := queryTimeoutDuration(models.DataSourceSettings{}); got != 30*time.Second {
		t.Errorf("default query timeout = %v, want 30s", got)
	}
	if got := queryTimeoutDuration(models.DataSourceSettings{QueryTimeout: -1}); got != 0 {
		t.Errorf("disabled query timeout = %v, want 0", got)
	}
	if got := maxRowsValue(models.DataSourceSettings{}); got != DefaultMaxRows {
		t.Errorf("default max rows = %d, want %d", got, DefaultMaxRows)
	}
	if got := maxRowsValue(models.DataSourceSettings{MaxRows: -1}); got != 0 {
		t.Errorf("disabled max rows = %d, want 0", got)
	}
	if got := maxRowsValue(models.DataSourceSettings{MaxRows: 10}); got != 10 {
		t.Errorf("configured max rows = %d, want 10", got)
	}
}

func TestSanitizeErrorRedactsCredentials(t *testing.T) {
	err := errors.New(`could not connect to postgres://root:s3cret@db.example.com:26257/example_db: refused`)
	got := sanitizeError(err)
	if strings.Contains(got, "s3cret") {
		t.Fatalf("sanitizeError leaked the password: %q", got)
	}
	if !strings.Contains(got, "postgres://***@") {
		t.Fatalf("sanitizeError = %q, want redacted userinfo", got)
	}
}

func TestErrorSourceClassification(t *testing.T) {
	dbErr := &pgconn.PgError{Code: "XXUUU", Message: "boom"}
	if got := errorSourceFor(dbErr); got != backend.ErrorSourceDownstream {
		t.Errorf("PgError source = %v, want downstream", got)
	}
	if got := errorSourceFor(context.DeadlineExceeded); got != backend.ErrorSourceDownstream {
		t.Errorf("deadline source = %v, want downstream", got)
	}
	if got := errorSourceFor(errors.New("conversion failed")); got != backend.ErrorSourcePlugin {
		t.Errorf("plain error source = %v, want plugin", got)
	}
}

func TestQueryDataRejectsEmptyQuery(t *testing.T) {
	ds := Datasource{}
	resp, err := ds.QueryData(context.Background(), &backend.QueryDataRequest{
		Queries: []backend.DataQuery{{RefID: "A", JSON: json.RawMessage(`{"rawSql":"   "}`)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	dr := resp.Responses["A"]
	if dr.Error == nil {
		t.Fatal("expected an error for an empty query")
	}
	if !strings.Contains(dr.Error.Error(), "query is empty") {
		t.Fatalf("error = %q, want a message about an empty query", dr.Error)
	}
	if dr.Status != backend.StatusBadRequest {
		t.Fatalf("status = %v, want bad request", dr.Status)
	}
}

func TestQueryDataRejectsUnsupportedAdHocFiltering(t *testing.T) {
	// The frontend cannot add Ad Hoc filters to a joined Raw SQL statement and
	// carries the reason on the query. The backend must surface it as a panel
	// error instead of executing the statement and returning unfiltered rows.
	ds := Datasource{}
	resp, err := ds.QueryData(context.Background(), &backend.QueryDataRequest{
		Queries: []backend.DataQuery{{RefID: "A", JSON: json.RawMessage(
			`{"rawSql":"SELECT * FROM a JOIN b ON a.id = b.id","adHocError":"Ad Hoc filters cannot be applied to Raw SQL that joins tables."}`,
		)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	dr := resp.Responses["A"]
	if dr.Error == nil {
		t.Fatal("expected the Ad Hoc limitation to be reported as a query error")
	}
	if !strings.Contains(dr.Error.Error(), "joins tables") {
		t.Fatalf("error = %q, want the frontend reason", dr.Error)
	}
	if dr.Status != backend.StatusBadRequest {
		t.Fatalf("status = %v, want bad request", dr.Status)
	}
}

func TestRowsToFramesCancelOnTruncate(t *testing.T) {
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "time", DataTypeOID: 1184},
			{Name: "value", DataTypeOID: 701},
		},
		rows: [][]any{
			{ts, 1.0}, {ts.Add(time.Second), 2.0}, {ts.Add(2 * time.Second), 3.0},
		},
	}
	cancelled := 0
	frames, err := RowsToFrames(rows, FrameOptions{
		Format:     "table",
		MaxRows:    2,
		OnTruncate: func() { cancelled++ },
	})
	if err != nil {
		t.Fatal(err)
	}
	if cancelled != 1 {
		t.Fatalf("OnTruncate called %d times, want 1", cancelled)
	}
	if len(frames) != 1 || frames[0].Fields[0].Len() != 2 {
		t.Fatalf("expected a frame truncated to 2 rows")
	}
}

func TestTimeSeriesRejectsNullTimeValues(t *testing.T) {
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "ts", DataTypeOID: 1184},
			{Name: "value", DataTypeOID: 701},
		},
		rows: [][]any{{ts, 1.0}, {nil, 2.0}},
	}
	_, err := RowsToFrame(rows, "time_series", "ts", nil)
	if err == nil || !strings.Contains(err.Error(), "NULL") {
		t.Fatalf("err = %v, want an error about NULL time values", err)
	}
}

func TestTimeSeriesRejectsUnknownConfiguredTimeColumn(t *testing.T) {
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "ts", DataTypeOID: 1184},
			{Name: "value", DataTypeOID: 701},
		},
		rows: [][]any{{ts, 1.0}},
	}
	_, err := RowsToFrame(rows, "time_series", "nope", nil)
	if err == nil || !strings.Contains(err.Error(), "was not returned by the query") {
		t.Fatalf("err = %v, want an error about the missing time column", err)
	}
}

func TestFrameRendersExtendedPostgresTypes(t *testing.T) {
	date := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	uuid := [16]byte{0x0f, 0x8f, 0xad, 0x5b, 0xd9, 0xcb, 0x46, 0x9f, 0xa1, 0x65, 0x70, 0x86, 0x77, 0x28, 0x95, 0x0e}
	rows := &mockRows{
		fields: []pgconn.FieldDescription{
			{Name: "d", DataTypeOID: 1082},
			{Name: "id", DataTypeOID: 2950},
			{Name: "span", DataTypeOID: 1186},
		},
		rows: [][]any{{date, uuid, pgtype.Interval{Days: 1, Microseconds: 3600000000, Valid: true}}},
	}
	frame, err := RowsToFrame(rows, "table", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if frame.Fields[0].Type() != data.FieldTypeTime {
		t.Errorf("date field type = %v, want time", frame.Fields[0].Type())
	}
	if got := frame.Fields[1].At(0).(string); got != "0f8fad5b-d9cb-469f-a165-70867728950e" {
		t.Errorf("uuid = %q, want canonical string form", got)
	}
	if got := frame.Fields[2].At(0).(string); !strings.Contains(got, "1 days") {
		t.Errorf("interval = %q, want a readable interval", got)
	}
}
