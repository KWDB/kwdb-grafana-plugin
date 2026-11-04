package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/jackc/pgx/v5"
)

func TestParseDDL(t *testing.T) {
	ddl := `CREATE TABLE ts_db.sensors (
    ts TIMESTAMP NOT NULL,
    temperature DOUBLE,
    humidity DOUBLE
) TAGS (
    device_id INT NOT NULL,
    location VARCHAR(100)
) PRIMARY TAGS (device_id);`

	infos := parseDDL(ddl)
	if len(infos) != 5 {
		t.Fatalf("got %d columns, want 5: %#v", len(infos), infos)
	}
	if infos[0].Name != "ts" || !infos[0].IsTimeColumn || infos[0].IsTag {
		t.Errorf("unexpected ts column: %#v", infos[0])
	}
	if infos[1].Name != "temperature" || infos[1].Type != "DOUBLE" {
		t.Errorf("unexpected temperature column: %#v", infos[1])
	}
	deviceID := infos[3]
	if deviceID.Name != "device_id" || !deviceID.IsTag || !deviceID.IsPrimaryTag || deviceID.Type != "INT" {
		t.Errorf("unexpected device_id column: %#v", deviceID)
	}
	if !infos[4].IsTag || infos[4].Name != "location" || infos[4].Type != "VARCHAR(100)" {
		t.Errorf("unexpected location column: %#v", infos[4])
	}
}

func TestParseDDLRelationalTable(t *testing.T) {
	ddl := `CREATE TABLE devices (id INT PRIMARY KEY, name VARCHAR(100));`
	infos := parseDDL(ddl)
	if len(infos) != 2 {
		t.Fatalf("got %d columns, want 2", len(infos))
	}
	for _, info := range infos {
		if info.IsTag || info.IsPrimaryTag {
			t.Errorf("relational column should not be a tag: %#v", info)
		}
	}
}

func TestParseDDLComplexKWDB(t *testing.T) {
	ddl := `CREATE TABLE device_info (
    create_time TIMESTAMPTZ NOT NULL,
    device_id INT COMMENT 'device ID' NOT NULL,
    install_date TIMESTAMPTZ,
    warranty_period INT2
) TAGS (
    plant_code INT2 NOT NULL COMMENT = 'plant code',
    workshop VARCHAR(128) NOT NULL,
    device_type CHAR(1023) NOT NULL,
    manufacturer NCHAR(254) NOT NULL
) PRIMARY TAGS(plant_code, workshop, device_type, manufacturer) COMMENT = 'table for device information';`

	infos := parseDDL(ddl)
	if len(infos) != 8 {
		t.Fatalf("got %d columns, want 8: %#v", len(infos), infos)
	}
	if !infos[0].IsTimeColumn || infos[0].Type != "TIMESTAMPTZ" {
		t.Errorf("unexpected create_time column: %#v", infos[0])
	}
	if infos[1].Type != "INT" {
		t.Errorf("unexpected device_id type: %#v", infos[1])
	}
	primary := map[string]bool{}
	for _, info := range infos {
		if info.IsPrimaryTag {
			primary[info.Name] = true
		}
	}
	for _, name := range []string{"plant_code", "workshop", "device_type", "manufacturer"} {
		if !primary[name] {
			t.Errorf("expected primary tag %s, got %#v", name, infos)
		}
	}
}

func TestParseDDLFailureReturnsNil(t *testing.T) {
	if infos := parseDDL("not a create table statement"); infos != nil {
		t.Fatalf("expected nil, got %#v", infos)
	}
}

func TestTablesResource(t *testing.T) {
	handler := newMetadataHandler(&fakeQuerier{
		fn: func(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
			return &mockRows{rows: [][]any{{"sensors", "TIME SERIES TABLE"}, {"devices", "TABLE"}}}, nil
		},
	}, "defaultdb")

	resp := callResource(t, handler, "/tables")
	if resp.Status != 200 {
		t.Fatalf("status = %d, body = %s", resp.Status, resp.Body)
	}
	var tables []TableInfo
	if err := json.Unmarshal(resp.Body, &tables); err != nil {
		t.Fatal(err)
	}
	if len(tables) != 2 || tables[0].Name != "sensors" || tables[0].Type != "TIME SERIES TABLE" ||
		tables[1].Name != "devices" || tables[1].Type != "TABLE" {
		t.Errorf("unexpected tables: %#v", tables)
	}
}

func TestTablesResourceQueryError(t *testing.T) {
	handler := newMetadataHandler(&fakeQuerier{
		fn: func(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
			return nil, errors.New("connection refused")
		},
	}, "defaultdb")

	resp := callResource(t, handler, "/tables")
	if resp.Status != 500 {
		t.Fatalf("status = %d, want 500", resp.Status)
	}
}

func TestColumnsResource(t *testing.T) {
	ddl := `CREATE TABLE iot_db.sensor_data (
    ts TIMESTAMPTZ NOT NULL,
    temperature DOUBLE,
    device_id INT4
) TAGS (
    device_id INT4 NOT NULL,
    location VARCHAR(100)
) PRIMARY TAGS (device_id)`

	handler := newMetadataHandler(&fakeQuerier{
		fn: func(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
			return &mockRows{rows: [][]any{{"sensor_data", ddl}}}, nil
		},
	}, "iot_db")

	resp := callResource(t, handler, "/columns?table=sensor_data")
	if resp.Status != 200 {
		t.Fatalf("status = %d, body = %s", resp.Status, resp.Body)
	}
	var cols []ColumnInfo
	if err := json.Unmarshal(resp.Body, &cols); err != nil {
		t.Fatal(err)
	}
	if len(cols) != 4 {
		t.Fatalf("got %d columns, want 4: %#v", len(cols), cols)
	}
	if !cols[0].IsTimeColumn {
		t.Errorf("expected ts time column: %#v", cols[0])
	}
	if !cols[2].IsTag || !cols[2].IsPrimaryTag || cols[2].Name != "device_id" {
		t.Errorf("unexpected device_id column: %#v", cols[2])
	}
	if !cols[3].IsTag || cols[3].Name != "location" {
		t.Errorf("unexpected location column: %#v", cols[3])
	}
}

func TestColumnsResourceMissingTable(t *testing.T) {
	handler := newMetadataHandler(&fakeQuerier{}, "defaultdb")
	resp := callResource(t, handler, "/columns")
	if resp.Status != 400 {
		t.Fatalf("status = %d, want 400", resp.Status)
	}
}

func TestColumnsResourceQueryError(t *testing.T) {
	handler := newMetadataHandler(&fakeQuerier{
		fn: func(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
			return nil, errors.New("table does not exist")
		},
	}, "defaultdb")

	resp := callResource(t, handler, "/columns?table=missing")
	if resp.Status != 500 {
		t.Fatalf("status = %d, want 500", resp.Status)
	}
}

func TestColumnsResourceUnparseableDDL(t *testing.T) {
	handler := newMetadataHandler(&fakeQuerier{
		fn: func(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
			return &mockRows{rows: [][]any{{"weird", "not a create table"}}}, nil
		},
	}, "defaultdb")

	resp := callResource(t, handler, "/columns?table=weird")
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200", resp.Status)
	}
	if string(resp.Body) != "[]\n" {
		t.Fatalf("body = %q, want []", resp.Body)
	}
}

func TestTagKeysResource(t *testing.T) {
	ddl := `CREATE TABLE iot_db.sensors (
    ts TIMESTAMPTZ NOT NULL,
    temperature DOUBLE
) TAGS (
    device_id VARCHAR(100) NOT NULL,
    location VARCHAR(100) NOT NULL
) PRIMARY TAGS (device_id)`

	handler := newMetadataHandler(&fakeQuerier{
		fn: func(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
			return &mockRows{rows: [][]any{{"sensors", ddl}}}, nil
		},
	}, "iot_db")

	resp := callResource(t, handler, "/tag-keys?table=sensors")
	if resp.Status != 200 {
		t.Fatalf("status = %d, body = %s", resp.Status, resp.Body)
	}
	var keys []string
	if err := json.Unmarshal(resp.Body, &keys); err != nil {
		t.Fatal(err)
	}
	if len(keys) != 2 || keys[0] != "device_id" || keys[1] != "location" {
		t.Errorf("unexpected tag keys: %#v", keys)
	}
}

func TestTagKeysMissingTable(t *testing.T) {
	handler := newMetadataHandler(&fakeQuerier{}, "iot_db")
	resp := callResource(t, handler, "/tag-keys")
	if resp.Status != 400 {
		t.Fatalf("status = %d, want 400", resp.Status)
	}
}

func TestTagKeysResourceError(t *testing.T) {
	handler := newMetadataHandler(&fakeQuerier{
		fn: func(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
			return nil, errors.New("catalog unavailable")
		},
	}, "iot_db")

	resp := callResource(t, handler, "/tag-keys?table=sensors")
	if resp.Status != 500 {
		t.Fatalf("status = %d, want 500", resp.Status)
	}
	if !strings.Contains(string(resp.Body), "catalog unavailable") {
		t.Fatalf("body = %q, want the database error", resp.Body)
	}
}

func TestTagKeysEmptyListIsJSONArray(t *testing.T) {
	ddl := `CREATE TABLE iot_db.metrics (
    ts TIMESTAMPTZ NOT NULL,
    value DOUBLE
)`
	handler := newMetadataHandler(&fakeQuerier{
		fn: func(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
			return &mockRows{rows: [][]any{{"metrics", ddl}}}, nil
		},
	}, "iot_db")

	resp := callResource(t, handler, "/tag-keys?table=metrics")
	if resp.Status != 200 {
		t.Fatalf("status = %d, body = %s", resp.Status, resp.Body)
	}
	if string(resp.Body) != "[]\n" {
		t.Fatalf("body = %q, want []", resp.Body)
	}
}

func TestTagKeysMethodNotAllowed(t *testing.T) {
	handler := newMetadataHandler(&fakeQuerier{}, "iot_db")
	var resp backend.CallResourceResponse
	err := handler.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: backend.PluginContext{DataSourceInstanceSettings: &backend.DataSourceInstanceSettings{}},
		Method:        "POST",
		Path:          "/tag-keys",
		URL:           "/tag-keys?table=sensors",
	}, backend.CallResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
		resp = *r
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Status != 405 {
		t.Fatalf("status = %d, want 405", resp.Status)
	}
}

func TestQualifiedTableNames(t *testing.T) {
	ddl := `CREATE TABLE demo_ts.sensors (
    ts TIMESTAMPTZ NOT NULL,
    temperature DOUBLE
) TAGS (
    device_id INT NOT NULL
) PRIMARY TAGS (device_id)`

	var statements []string
	handler := newMetadataHandler(&fakeQuerier{
		fn: func(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
			statements = append(statements, sql)
			if strings.HasPrefix(sql, "SHOW CREATE TABLE") {
				return &mockRows{rows: [][]any{{"sensors", ddl}}}, nil
			}
			return &mockRows{rows: [][]any{{int64(1)}}}, nil
		},
	}, "factory")

	resp := callResource(t, handler, "/tag-keys?table=demo_ts.sensors")
	if resp.Status != 200 {
		t.Fatalf("status = %d, body = %s", resp.Status, resp.Body)
	}
	want := `SHOW CREATE TABLE "demo_ts"."sensors"`
	if len(statements) == 0 || statements[0] != want {
		t.Fatalf("statements = %#v, want %q", statements, want)
	}
	if strings.Contains(statements[0], `"factory"`) {
		t.Fatalf("qualified name must not be prefixed with the configured database: %q", statements[0])
	}
}

func TestSplitTableName(t *testing.T) {
	cases := map[string][]string{
		"":                  nil,
		"sensors":           {"sensors"},
		"demo_ts.sensors":   {"demo_ts", "sensors"},
		`demo_ts."a.b"`:     {"demo_ts", "a.b"},
		`demo_ts."odd""nm"`: {"demo_ts", `odd"nm`},
	}
	for input, want := range cases {
		got := splitTableName(input)
		if strings.Join(got, "\x1f") != strings.Join(want, "\x1f") {
			t.Errorf("splitTableName(%q) = %#v, want %#v", input, got, want)
		}
	}
}

func TestTagValuesResource(t *testing.T) {
	ddl := `CREATE TABLE iot_db.sensors (
    ts TIMESTAMPTZ NOT NULL,
    temperature DOUBLE
) TAGS (
    device_id VARCHAR(100) NOT NULL
) PRIMARY TAGS (device_id)`

	var capturedSQL string
	handler := newMetadataHandler(&fakeQuerier{
		fn: func(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
			if strings.HasPrefix(sql, "SELECT DISTINCT") {
				capturedSQL = sql
				return &mockRows{rows: [][]any{{"CNC-001"}, {"CNC-002"}, {"INJ-001"}}}, nil
			}
			return &mockRows{rows: [][]any{{"sensors", ddl}}}, nil
		},
	}, "iot_db")

	resp := callResource(t, handler, "/tag-values?table=sensors&column=device_id")
	if resp.Status != 200 {
		t.Fatalf("status = %d, body = %s", resp.Status, resp.Body)
	}
	var values []string
	if err := json.Unmarshal(resp.Body, &values); err != nil {
		t.Fatal(err)
	}
	if len(values) != 3 || values[0] != "CNC-001" || values[1] != "CNC-002" || values[2] != "INJ-001" {
		t.Errorf("unexpected tag values: %#v", values)
	}
	wantSQL := `SELECT DISTINCT "device_id" FROM "iot_db"."sensors" ORDER BY "device_id" LIMIT 10000`
	if capturedSQL != wantSQL {
		t.Errorf("sql = %q, want %q", capturedSQL, wantSQL)
	}
}

func TestTagValuesNonStringTags(t *testing.T) {
	ddl := `CREATE TABLE iot_db.sensors (
    ts TIMESTAMPTZ NOT NULL,
    temperature DOUBLE
) TAGS (
    device_id INT NOT NULL
) PRIMARY TAGS (device_id)`

	handler := newMetadataHandler(&fakeQuerier{
		fn: func(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
			if strings.HasPrefix(sql, "SELECT DISTINCT") {
				return &mockRows{rows: [][]any{{int64(101)}, {int64(202)}}}, nil
			}
			return &mockRows{rows: [][]any{{"sensors", ddl}}}, nil
		},
	}, "iot_db")

	resp := callResource(t, handler, "/tag-values?table=sensors&column=device_id")
	if resp.Status != 200 {
		t.Fatalf("status = %d, body = %s", resp.Status, resp.Body)
	}
	var values []string
	if err := json.Unmarshal(resp.Body, &values); err != nil {
		t.Fatal(err)
	}
	if len(values) != 2 || values[0] != "101" || values[1] != "202" {
		t.Errorf("unexpected tag values: %#v", values)
	}
}

func TestTagValuesEmptyResult(t *testing.T) {
	ddl := `CREATE TABLE iot_db.sensors (
    ts TIMESTAMPTZ NOT NULL,
    temperature DOUBLE
) TAGS (
    device_id INT NOT NULL
) PRIMARY TAGS (device_id)`

	handler := newMetadataHandler(&fakeQuerier{
		fn: func(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
			if strings.HasPrefix(sql, "SELECT DISTINCT") {
				return &mockRows{}, nil
			}
			return &mockRows{rows: [][]any{{"sensors", ddl}}}, nil
		},
	}, "iot_db")

	resp := callResource(t, handler, "/tag-values?table=sensors&column=device_id")
	if resp.Status != 200 {
		t.Fatalf("status = %d, body = %s", resp.Status, resp.Body)
	}
	if string(resp.Body) != "[]\n" {
		t.Fatalf("body = %q, want []", resp.Body)
	}
}

func TestTagValuesMissingParams(t *testing.T) {
	handler := newMetadataHandler(&fakeQuerier{}, "defaultdb")

	resp := callResource(t, handler, "/tag-values?table=sensors")
	if resp.Status != 400 {
		t.Fatalf("status = %d, want 400", resp.Status)
	}
	resp = callResource(t, handler, "/tag-values?column=device_id")
	if resp.Status != 400 {
		t.Fatalf("status = %d, want 400", resp.Status)
	}
}

func TestTagValuesNotATagColumn(t *testing.T) {
	ddl := `CREATE TABLE iot_db.sensors (
    ts TIMESTAMPTZ NOT NULL,
    temperature DOUBLE
) TAGS (
    device_id INT NOT NULL
) PRIMARY TAGS (device_id)`

	handler := newMetadataHandler(&fakeQuerier{
		fn: func(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
			return &mockRows{rows: [][]any{{"sensors", ddl}}}, nil
		},
	}, "iot_db")

	// temperature exists but is not a tag; unknown does not exist at all.
	for _, column := range []string{"temperature", "unknown"} {
		resp := callResource(t, handler, "/tag-values?table=sensors&column="+column)
		if resp.Status != 400 {
			t.Fatalf("column %s: status = %d, want 400", column, resp.Status)
		}
	}
}

func TestTagValuesTableNotFound(t *testing.T) {
	handler := newMetadataHandler(&fakeQuerier{
		fn: func(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
			return nil, errors.New(`relation "iot_db.missing" does not exist`)
		},
	}, "iot_db")

	resp := callResource(t, handler, "/tag-values?table=missing&column=device_id")
	if resp.Status != 500 {
		t.Fatalf("status = %d, want 500", resp.Status)
	}
}

func TestTagValuesQueryError(t *testing.T) {
	ddl := `CREATE TABLE iot_db.sensors (
    ts TIMESTAMPTZ NOT NULL,
    temperature DOUBLE
) TAGS (
    device_id INT NOT NULL
) PRIMARY TAGS (device_id)`

	handler := newMetadataHandler(&fakeQuerier{
		fn: func(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
			if strings.HasPrefix(sql, "SELECT DISTINCT") {
				return nil, errors.New("connection refused")
			}
			return &mockRows{rows: [][]any{{"sensors", ddl}}}, nil
		},
	}, "iot_db")

	resp := callResource(t, handler, "/tag-values?table=sensors&column=device_id")
	if resp.Status != 500 {
		t.Fatalf("status = %d, want 500", resp.Status)
	}
}
