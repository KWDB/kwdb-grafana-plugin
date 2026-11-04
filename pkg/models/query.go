package models

// AdHocFilter is one dashboard Ad Hoc filter rendered by the frontend.
//
// The frontend sends the predicate in SQL form ("key" = 'value', with the
// identifier quoted and the value escaped) because it owns the SQL dialect and
// the dashboard variable interpolation. The Key is kept separately so the
// backend can decide whether the target's table actually declares that column
// before injecting the predicate.
type AdHocFilter struct {
	// Key is the unquoted column name the filter refers to.
	Key string `json:"key"`
	// Operator is the comparison operator as written in SQL.
	Operator string `json:"operator"`
	// Condition is the fully rendered SQL predicate, already quoted and escaped.
	Condition string `json:"condition"`
}

// QueryModel is the backend representation of the frontend query JSON.
type QueryModel struct {
	Mode       string   `json:"mode"`
	Format     string   `json:"format"`
	RawSql     string   `json:"rawSql"`
	TimeColumn string   `json:"timeColumn"`
	Tags       []string `json:"tags"`
	// Table is the source table of a builder target, used to decide whether an
	// Ad Hoc filter applies to it.
	Table string `json:"table,omitempty"`
	// SplitByTag controls whether latest-values results are split into one
	// frame per tag combination. Nil means true (split by default).
	SplitByTag *bool `json:"splitByTag,omitempty"`
	// AdHocFilters carries the dashboard filters for this target only. Grafana
	// passes one filter list per request, so the frontend attaches it to each
	// target; the backend then applies only those whose column the target's
	// table declares.
	AdHocFilters []AdHocFilter `json:"adHocFilters,omitempty"`
	// AdHocTable names the table a Raw SQL target reads from, used for the
	// same applicability check. Builder targets use Table.
	AdHocTable string `json:"adHocTable,omitempty"`
	// AdHocFiltered reports that the frontend already injected the conditions
	// into RawSql, so the backend must not inject them a second time.
	AdHocFiltered bool `json:"adHocFiltered,omitempty"`
	// AdHocError is set by the frontend when dashboard Ad Hoc filters cannot be
	// applied to the target. The backend reports it as a query error so the
	// panel displays the reason instead of running the statement unfiltered.
	AdHocError string `json:"adHocError,omitempty"`
}
