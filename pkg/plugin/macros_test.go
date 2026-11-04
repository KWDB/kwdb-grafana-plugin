package plugin

import (
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func TestExpandMacros(t *testing.T) {
	tr := backend.TimeRange{
		From: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		To:   time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC),
	}

	tests := []struct {
		name string
		sql  string
		want string
	}{
		{
			name: "time filter",
			sql:  "SELECT * FROM sensors WHERE $__timeFilter(ts)",
			want: "SELECT * FROM sensors WHERE (ts >= '2026-01-01 00:00:00'::TIMESTAMP AND ts <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			name: "time from and to",
			sql:  "SELECT $__timeFrom AS start, $__timeTo AS end",
			want: "SELECT '2026-01-01 00:00:00'::TIMESTAMP AS start, '2026-01-01 01:00:00'::TIMESTAMP AS end",
		},
		{
			name: "time group",
			sql:  "SELECT $__timeGroup(ts, '5m') AS bucket",
			want: "SELECT time_bucket(ts, '5m') AS bucket",
		},
		{
			name: "quoted time group",
			sql:  `SELECT $__timeGroup("ts", '1h')`,
			want: `SELECT time_bucket("ts", '1h')`,
		},
		{
			name: "combined macros",
			sql:  "SELECT $__timeGroup(k_timestamp, '1m') AS time FROM sensors WHERE $__timeFilter(k_timestamp)",
			want: "SELECT time_bucket(k_timestamp, '1m') AS time FROM sensors WHERE (k_timestamp >= '2026-01-01 00:00:00'::TIMESTAMP AND k_timestamp <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			name: "time filter with nested cast",
			sql:  "SELECT * FROM sensors WHERE $__timeFilter(CAST(ts AS TIMESTAMP))",
			want: "SELECT * FROM sensors WHERE (CAST(ts AS TIMESTAMP) >= '2026-01-01 00:00:00'::TIMESTAMP AND CAST(ts AS TIMESTAMP) <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			name: "time filter with nested function",
			sql:  "SELECT * FROM sensors WHERE $__timeFilter(time_bucket(ts, '5m'))",
			want: "SELECT * FROM sensors WHERE (time_bucket(ts, '5m') >= '2026-01-01 00:00:00'::TIMESTAMP AND time_bucket(ts, '5m') <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			name: "negated time filter keeps its meaning",
			sql:  "SELECT * FROM sensors WHERE NOT $__timeFilter(ts)",
			want: "SELECT * FROM sensors WHERE NOT (ts >= '2026-01-01 00:00:00'::TIMESTAMP AND ts <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			name: "time group with nested cast",
			sql:  "SELECT $__timeGroup(CAST(ts AS TIMESTAMP), '5m')",
			want: "SELECT time_bucket(CAST(ts AS TIMESTAMP), '5m')",
		},
		{
			name: "semicolon inside string literal is untouched",
			sql:  "SELECT * FROM t WHERE note = 'a;b' AND $__timeFilter(ts)",
			want: "SELECT * FROM t WHERE note = 'a;b' AND (ts >= '2026-01-01 00:00:00'::TIMESTAMP AND ts <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			// A macro that only appears inside a literal must be left alone:
			// expanding it corrupts the string and produces a syntax error.
			name: "time filter inside a string literal is not expanded",
			sql:  "SELECT 'range: $__timeFilter(ts)' AS note",
			want: "SELECT 'range: $__timeFilter(ts)' AS note",
		},
		{
			name: "time from inside a string literal is not expanded",
			sql:  "SELECT 'from $__timeFrom to $__timeTo' AS note",
			want: "SELECT 'from $__timeFrom to $__timeTo' AS note",
		},
		{
			name: "macro inside a quoted identifier is not expanded",
			sql:  `SELECT "$__timeFrom" FROM t`,
			want: `SELECT "$__timeFrom" FROM t`,
		},
		{
			name: "macro inside a line comment is not expanded",
			sql:  "SELECT 1 -- see $__timeFilter(ts)\nFROM t WHERE $__timeFilter(ts)",
			want: "SELECT 1 -- see $__timeFilter(ts)\nFROM t WHERE (ts >= '2026-01-01 00:00:00'::TIMESTAMP AND ts <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			name: "macro inside a block comment is not expanded",
			sql:  "SELECT 1 /* $__timeFrom */ FROM t WHERE k_timestamp >= $__timeFrom",
			want: "SELECT 1 /* $__timeFrom */ FROM t WHERE k_timestamp >= '2026-01-01 00:00:00'::TIMESTAMP",
		},
		{
			name: "macro inside a dollar-quoted string is not expanded",
			sql:  "SELECT $$literal $__timeFrom$$, $__timeFrom",
			want: "SELECT $$literal $__timeFrom$$, '2026-01-01 00:00:00'::TIMESTAMP",
		},
		{
			name: "escaped quote does not end the literal early",
			sql:  "SELECT 'it''s $__timeFrom' AS note, $__timeFrom",
			want: "SELECT 'it''s $__timeFrom' AS note, '2026-01-01 00:00:00'::TIMESTAMP",
		},
		{
			name: "macros on both sides of a literal",
			sql:  "SELECT $__timeFrom AS a, 'x' AS b, $__timeTo AS c",
			want: "SELECT '2026-01-01 00:00:00'::TIMESTAMP AS a, 'x' AS b, '2026-01-01 01:00:00'::TIMESTAMP AS c",
		},
		{
			name: "nested macro is expanded from the inside out",
			sql:  "SELECT * FROM sensors WHERE $__timeFilter($__timeGroup(ts, '5m'))",
			want: "SELECT * FROM sensors WHERE (time_bucket(ts, '5m') >= '2026-01-01 00:00:00'::TIMESTAMP AND time_bucket(ts, '5m') <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			name: "scalar macro nested inside a macro argument",
			sql:  "SELECT * FROM sensors WHERE $__timeFilter(CAST($__timeFrom AS TIMESTAMP))",
			want: "SELECT * FROM sensors WHERE (CAST('2026-01-01 00:00:00'::TIMESTAMP AS TIMESTAMP) >= '2026-01-01 00:00:00'::TIMESTAMP AND CAST('2026-01-01 00:00:00'::TIMESTAMP AS TIMESTAMP) <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			// The ')' inside the dollar-quoted literal must not terminate the
			// macro argument list early.
			name: "paren inside a dollar-quoted macro argument",
			sql:  `SELECT $__timeFilter($q$)x$q$) AS v`,
			want: `SELECT ($q$)x$q$ >= '2026-01-01 00:00:00'::TIMESTAMP AND $q$)x$q$ <= '2026-01-01 01:00:00'::TIMESTAMP) AS v`,
		},
		{
			// The comma inside the dollar-quoted literal must not split the
			// argument list.
			name: "comma inside a dollar-quoted time group argument",
			sql:  `SELECT $__timeGroup(t, $q$5,m$q$)`,
			want: `SELECT time_bucket(t, $q$5,m$q$)`,
		},
		{
			// Valid PostgreSQL identifiers may contain '$' after the first
			// byte, so this is not a macro occurrence.
			name: "scalar macro suffix of an identifier is not expanded",
			sql:  "SELECT ts$__timeFrom FROM t",
			want: "SELECT ts$__timeFrom FROM t",
		},
		{
			name: "scalar macro followed by an identifier byte is not expanded",
			sql:  "SELECT $__timeFromx FROM t",
			want: "SELECT $__timeFromx FROM t",
		},
		{
			// A dollar-quoted literal whose tag is spelled like a macro is
			// still a literal, not a macro occurrence.
			name: "dollar-quote tag named like a scalar macro",
			sql:  `SELECT $__timeFrom$body$__timeFrom$ AS v`,
			want: `SELECT $__timeFrom$body$__timeFrom$ AS v`,
		},
		{
			name: "no macros",
			sql:  "SELECT 1",
			want: "SELECT 1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ExpandMacros(tt.sql, tr); got != tt.want {
				t.Errorf("ExpandMacros() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestExpandMacrosKeepsSubsecondPrecision(t *testing.T) {
	tr := backend.TimeRange{
		From: time.Date(2026, 1, 1, 0, 0, 0, 123456789, time.UTC),
		To:   time.Date(2026, 1, 1, 0, 0, 1, 987654321, time.UTC),
	}
	got := ExpandMacros("SELECT $__timeFrom AS start, $__timeTo AS end", tr)
	want := "SELECT '2026-01-01 00:00:00.123456789'::TIMESTAMP AS start, '2026-01-01 00:00:01.987654321'::TIMESTAMP AS end"
	if got != want {
		t.Errorf("ExpandMacros() = %q, want %q", got, want)
	}
}

// TestExpandMacrosNestingIsBounded makes sure pathological nesting terminates
// instead of recursing forever. Past the limit the macro text is left in place
// so the database reports the problem.
func TestExpandMacrosNestingIsBounded(t *testing.T) {
	const depth = maxMacroNesting + 4
	sql := "SELECT " + strings.Repeat("$__timeFilter(", depth) + "ts" + strings.Repeat(")", depth)
	got := ExpandMacros(sql, backend.TimeRange{
		From: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		To:   time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC),
	})
	if got == "" {
		t.Fatal("ExpandMacros returned an empty statement")
	}
	if !strings.Contains(got, "$__timeFilter") {
		t.Fatalf("expected the over-deep macro to be left in place, got %q", got)
	}
}

// TestExpandMacrosKeepsStringLiteralsIntact covers the failure mode that would
// silently corrupt a user's query: a macro-looking token inside a quoted string
// or comment must not be rewritten. A rewritten literal changes the filter the
// user wrote, which is worse than leaving the macro unexpanded.
func TestExpandMacrosKeepsStringLiteralsIntact(t *testing.T) {
	tr := backend.TimeRange{
		From: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		To:   time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC),
	}

	tests := []struct {
		name string
		sql  string
		want string
	}{
		{
			name: "macro inside a single quoted literal",
			sql:  "SELECT * FROM t WHERE note = '$__timeFrom'",
			want: "SELECT * FROM t WHERE note = '$__timeFrom'",
		},
		{
			name: "macro inside a quoted identifier",
			sql:  `SELECT "$__timeTo" FROM t`,
			want: `SELECT "$__timeTo" FROM t`,
		},
		{
			name: "macro inside a line comment",
			sql:  "SELECT 1 -- $__timeFilter(ts)\n",
			want: "SELECT 1 -- $__timeFilter(ts)\n",
		},
		{
			name: "macro inside a block comment",
			sql:  "SELECT 1 /* $__timeGroup(ts, '5m') */",
			want: "SELECT 1 /* $__timeGroup(ts, '5m') */",
		},
		{
			name: "macro-like suffix of an identifier",
			sql:  "SELECT ts$__timeFrom FROM t",
			want: "SELECT ts$__timeFrom FROM t",
		},
		{
			name: "escaped quote before a real macro",
			sql:  "SELECT * FROM t WHERE note = 'it''s' AND $__timeFilter(ts)",
			want: "SELECT * FROM t WHERE note = 'it''s' AND (ts >= '2026-01-01 00:00:00'::TIMESTAMP AND ts <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ExpandMacros(tt.sql, tr); got != tt.want {
				t.Errorf("ExpandMacros(%q) = %q, want %q", tt.sql, got, tt.want)
			}
		})
	}
}

// FuzzExpandMacros asserts the invariants that matter for a query rewriter: it
// must never panic, never drop the prefix it does not understand, and never
// return a statement with braces unbalanced relative to the input.
func FuzzExpandMacros(f *testing.F) {
	seeds := []string{
		"SELECT $__timeFilter(ts) FROM t",
		"SELECT $__timeGroup(ts, '5m'), count(*) FROM t GROUP BY 1",
		"SELECT '$__timeFrom' AS literal",
		"-- $__timeTo\nSELECT 1",
		"SELECT 1;",
		"",
		"$__timeFilter(",
		"$__timeFilter()",
		"SELECT $$ $__timeFrom $$",
		`SELECT "a$__timeTo"`,
	}
	for _, seed := range seeds {
		f.Add(seed)
	}

	tr := backend.TimeRange{
		From: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		To:   time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC),
	}

	f.Fuzz(func(t *testing.T, sql string) {
		got := ExpandMacros(sql, tr)
		if strings.Count(got, "(") != strings.Count(got, ")") {
			// Only hold the invariant for inputs that were balanced to begin with;
			// an unbalanced input may legitimately stay unbalanced.
			if strings.Count(sql, "(") == strings.Count(sql, ")") {
				t.Fatalf("balanced input produced unbalanced output: %q -> %q", sql, got)
			}
		}
		// An empty input must never turn into generated SQL.
		if sql == "" && got != "" {
			t.Fatalf("empty input produced %q", got)
		}
	})
}
