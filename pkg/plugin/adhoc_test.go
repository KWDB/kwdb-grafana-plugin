package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/KWDB/kwdb-grafana-plugin/pkg/models"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// fakeCatalog answers table column lookups for the per-target Ad Hoc tests.
type fakeCatalog struct {
	columns map[string][]string
	err     error
	lookups []string
}

func (c *fakeCatalog) lookup(_ context.Context, table string) ([]ColumnInfo, error) {
	c.lookups = append(c.lookups, table)
	if c.err != nil {
		return nil, c.err
	}
	var infos []ColumnInfo
	for _, name := range c.columns[table] {
		infos = append(infos, ColumnInfo{Name: name, IsTag: true})
	}
	return infos, nil
}

func adHocQuery(table string, filters ...models.AdHocFilter) models.QueryModel {
	return models.QueryModel{
		Mode:         "raw",
		Format:       "table",
		RawSql:       "SELECT * FROM " + table,
		AdHocTable:   table,
		AdHocFilters: filters,
	}
}

func TestApplicableFiltersIgnoresUndeclaredColumn(t *testing.T) {
	// Issue #80: a filter about a column the target's table does not declare
	// must be skipped, not injected.
	d := &Datasource{}
	catalog := &fakeCatalog{columns: map[string][]string{
		"inverter_telemetry": {"k_timestamp", "inverter_id", "ac_power_kw"},
	}}

	conditions, applicable, err := d.applicableFilters(
		context.Background(),
		adHocQuery("inverter_telemetry", models.AdHocFilter{
			Key: "model_code", Operator: "=", Condition: `"model_code" = 'KPV-340'`,
		}),
		newTableTagChecker(catalog.lookup),
	)
	if err != nil {
		t.Fatalf("applicableFilters returned an error: %v", err)
	}
	if !applicable {
		t.Fatal("a target with a known table is always applicable")
	}
	if len(conditions) != 0 {
		t.Fatalf("conditions = %#v, want none for an undeclared column", conditions)
	}
}

func TestApplicableFiltersAppliesDeclaredColumn(t *testing.T) {
	d := &Datasource{}
	catalog := &fakeCatalog{columns: map[string][]string{
		"station_telemetry": {"k_timestamp", "station_id", "ac_power_kw"},
	}}

	conditions, _, err := d.applicableFilters(
		context.Background(),
		adHocQuery("station_telemetry", models.AdHocFilter{
			Key: "station_id", Operator: "=", Condition: `"station_id" = 'PV-A07'`,
		}),
		newTableTagChecker(catalog.lookup),
	)
	if err != nil {
		t.Fatalf("applicableFilters returned an error: %v", err)
	}
	if len(conditions) != 1 || conditions[0] != `"station_id" = 'PV-A07'` {
		t.Fatalf("conditions = %#v, want the declared column's predicate", conditions)
	}
}

func TestApplicableFiltersMixedDashboardKeepsEachTargetCorrect(t *testing.T) {
	// The two panels of issue #80 share one filter: `station_id` exists in both
	// tables, `model_code` only in inverter_telemetry. Each target must end up
	// with exactly the predicates its own table declares.
	catalog := &fakeCatalog{columns: map[string][]string{
		"station_telemetry":  {"k_timestamp", "station_id", "ac_power_kw"},
		"inverter_telemetry": {"k_timestamp", "inverter_id", "station_id", "model_code", "ac_power_kw"},
	}}
	filters := []models.AdHocFilter{
		{Key: "station_id", Operator: "=", Condition: `"station_id" = 'PV-A07'`},
		{Key: "model_code", Operator: "=", Condition: `"model_code" = 'KPV-340'`},
	}
	d := &Datasource{}

	station, _, err := d.applicableFilters(context.Background(), adHocQuery("station_telemetry", filters...),
		newTableTagChecker(catalog.lookup))
	if err != nil {
		t.Fatal(err)
	}
	if len(station) != 1 || station[0] != `"station_id" = 'PV-A07'` {
		t.Fatalf("station conditions = %#v, want only station_id", station)
	}

	inverter, _, err := d.applicableFilters(context.Background(), adHocQuery("inverter_telemetry", filters...),
		newTableTagChecker(catalog.lookup))
	if err != nil {
		t.Fatal(err)
	}
	if len(inverter) != 2 {
		t.Fatalf("inverter conditions = %#v, want both filters", inverter)
	}
}

func TestApplicableFiltersSharesOneCatalogReadPerRequest(t *testing.T) {
	catalog := &fakeCatalog{columns: map[string][]string{"t": {"a", "b"}}}
	d := &Datasource{}
	checker := newTableTagChecker(catalog.lookup)

	filters := []models.AdHocFilter{
		{Key: "a", Operator: "=", Condition: `"a" = '1'`},
		{Key: "b", Operator: "=", Condition: `"b" = '2'`},
	}
	for i := 0; i < 2; i++ {
		if _, _, err := d.applicableFilters(context.Background(), adHocQuery("t", filters...), checker); err != nil {
			t.Fatal(err)
		}
	}
	if len(catalog.lookups) != 1 {
		t.Fatalf("catalog reads = %d, want 1 (cached per request)", len(catalog.lookups))
	}
}

func TestApplicableFiltersReportsCatalogFailure(t *testing.T) {
	// Treating an unreadable table as "no filter applies" would silently return
	// unfiltered rows, so the error has to surface.
	catalog := &fakeCatalog{err: errors.New("relation does not exist")}
	d := &Datasource{}

	_, _, err := d.applicableFilters(context.Background(), adHocQuery("missing_table", models.AdHocFilter{
		Key: "station_id", Operator: "=", Condition: `"station_id" = 'PV-A07'`,
	}), newTableTagChecker(catalog.lookup))
	if err == nil {
		t.Fatal("expected the catalog error to be reported")
	}
	if !strings.Contains(err.Error(), "missing_table") {
		t.Fatalf("error = %q, want the table name", err)
	}
}

func TestApplicableFiltersBuilderTargetUsesTableField(t *testing.T) {
	catalog := &fakeCatalog{columns: map[string][]string{"sensors": {"ts", "device_id"}}}
	d := &Datasource{}
	qm := models.QueryModel{
		Mode:       "downsampling",
		Table:      "sensors",
		AdHocFilters: []models.AdHocFilter{
			{Key: "device_id", Operator: "=", Condition: `"device_id" = '7'`},
		},
	}

	conditions, _, err := d.applicableFilters(context.Background(), qm, newTableTagChecker(catalog.lookup))
	if err != nil {
		t.Fatal(err)
	}
	if len(conditions) != 1 {
		t.Fatalf("conditions = %#v, want the builder filter", conditions)
	}
}

func TestApplicableFiltersSkipsWhenFrontendAlreadyInjected(t *testing.T) {
	// Raw SQL that the frontend could rewrite carries its predicate in RawSql.
	d := &Datasource{}
	qm := adHocQuery("t", models.AdHocFilter{Key: "a", Operator: "=", Condition: `"a" = '1'`})
	qm.AdHocFiltered = true

	conditions, applicable, err := d.applicableFilters(context.Background(), qm, newTableTagChecker(nil))
	if err != nil {
		t.Fatal(err)
	}
	if applicable || len(conditions) != 0 {
		t.Fatalf("conditions = %#v applicable = %v, want no second injection", conditions, applicable)
	}
}

func TestInjectAdHocConditionsBeforeLimit(t *testing.T) {
	got, err := injectAdHocConditions("SELECT a FROM t LIMIT 5", []string{`"a" = '1'`})
	if err != nil {
		t.Fatal(err)
	}
	where := strings.Index(got, "kwdb_adhoc")
	limit := strings.Index(got, "LIMIT")
	if where < 0 || limit < 0 || where > limit {
		t.Fatalf("injected = %q, want the predicate before LIMIT", got)
	}
}

func TestInjectAdHocConditionsBeforeGroupBy(t *testing.T) {
	got, err := injectAdHocConditions("SELECT avg(v) FROM t GROUP BY a", []string{`"a" = '1'`})
	if err != nil {
		t.Fatal(err)
	}
	where := strings.Index(got, "kwdb_adhoc")
	group := strings.Index(got, "GROUP BY")
	if where < 0 || group < 0 || where > group {
		t.Fatalf("injected = %q, want the predicate before GROUP BY", got)
	}
}

func TestInjectAdHocConditionsRejectsComplexSources(t *testing.T) {
	for _, sql := range []string{
		"SELECT * FROM a JOIN b ON a.id = b.id",
		"SELECT * FROM a, b",
		"SELECT * FROM a UNION SELECT * FROM b",
		"SELECT 1",
	} {
		if _, err := injectAdHocConditions(sql, []string{`"a" = '1'`}); err == nil {
			t.Errorf("injectAdHocConditions(%q) accepted a complex source", sql)
		}
	}
}

func TestInjectAdHocConditionsIsIdempotentWhenMarked(t *testing.T) {
	// The frontend never marks, but a repeated backend pass must not add the
	// predicate twice.
	once, err := injectAdHocConditions("SELECT a FROM t", []string{`"a" = '1'`})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(once, "kwdb_adhoc") != 1 {
		t.Fatalf("injected = %q, want exactly one marker", once)
	}
}

func TestQueryDataRejectsUndeclaredTagInsteadOfErroring(t *testing.T) {
	// End-to-end through QueryData: a filter on a column the target's table does
	// not declare must leave the statement untouched, so the database does not
	// fail with "column does not exist".
	catalog := &fakeCatalog{columns: map[string][]string{
		"inverter_telemetry": {"k_timestamp", "inverter_id", "ac_power_kw"},
	}}
	d := &Datasource{columns: catalog.lookup}

	qm := models.QueryModel{
		Mode:       "raw",
		Format:     "table",
		RawSql:     "SELECT * FROM inverter_telemetry",
		AdHocTable: "inverter_telemetry",
		AdHocFilters: []models.AdHocFilter{
			{Key: "model_code", Operator: "=", Condition: `"model_code" = 'KPV-340'`},
		},
	}
	raw, err := json.Marshal(qm)
	if err != nil {
		t.Fatal(err)
	}

	// The pool is nil, so reaching the database would panic; the point is that
	// the filter is not injected. The query fails later, with a connection
	// error, which proves the statement shape was accepted.
	req := &backend.QueryDataRequest{
		Queries: []backend.DataQuery{{RefID: "A", JSON: raw, TimeRange: backend.TimeRange{
			From: time.Now().Add(-time.Hour), To: time.Now(),
		}}},
	}
	resp, err := d.QueryData(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got := resp.Responses["A"].Error; got != nil && strings.Contains(got.Error(), "model_code") {
		t.Fatalf("error = %q, want the undeclared filter to be ignored", got)
	}
}
