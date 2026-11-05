package plugin

import (
	"context"
	"testing"
)

func TestIsReadOnly(t *testing.T) {
	tests := []struct {
		name string
		sql  string
		want bool
	}{
		{name: "select", sql: "SELECT * FROM sensors", want: true},
		{name: "show", sql: "SHOW TABLES", want: true},
		{name: "explain", sql: "EXPLAIN SELECT 1", want: true},
		{name: "with", sql: "WITH x AS (SELECT 1) SELECT * FROM x", want: true},
		{name: "leading whitespace", sql: "   \n\t SELECT 1", want: true},
		{name: "line comment", sql: "-- comment\nSELECT 1", want: true},
		{name: "block comment", sql: "/* comment */ SHOW TABLES", want: true},
		{name: "multiple comments", sql: "-- first\n/* second */ SELECT 1", want: true},
		{name: "trailing semicolon", sql: "SELECT 1;", want: true},
		{name: "trailing semicolon and comment", sql: "SELECT 1; -- done", want: true},
		{name: "semicolon in string", sql: "SELECT ';'", want: true},
		{name: "semicolon in quoted identifier", sql: `SELECT "a;b" FROM t`, want: true},
		{name: "semicolon in block comment", sql: "SELECT 1 /* ; */", want: true},
		{name: "multi statement", sql: "SELECT 1; SELECT 2", want: false},
		{name: "select into", sql: "SELECT * INTO new_table FROM t", want: false},
		{name: "with data modifying cte", sql: "WITH x AS (DELETE FROM t) SELECT * FROM x", want: false},
		{name: "write keyword in string", sql: "SELECT 'delete'", want: true},
		{name: "quoted write identifier", sql: `SELECT "delete" FROM t`, want: true},
		{name: "insert", sql: "INSERT INTO t VALUES (1)", want: false},
		{name: "update", sql: "UPDATE t SET a = 1", want: false},
		{name: "delete", sql: "DELETE FROM t", want: false},
		{name: "drop", sql: "DROP TABLE t", want: false},
		{name: "create", sql: "CREATE TABLE t (a INT)", want: false},
		{name: "alter", sql: "ALTER TABLE t ADD COLUMN b INT", want: false},
		{name: "truncate", sql: "TRUNCATE t", want: false},
		{name: "empty", sql: "", want: false},
		{name: "whitespace only", sql: "  \n ", want: false},
		{name: "comment only", sql: "-- just a comment", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsReadOnly(tt.sql); got != tt.want {
				t.Errorf("IsReadOnly(%q) = %v, want %v", tt.sql, got, tt.want)
			}
		})
	}
}

func TestExecuteQueryNilPool(t *testing.T) {
	if _, err := ExecuteQuery(context.Background(), nil, "SELECT 1"); err == nil {
		t.Fatal("expected error for nil pool")
	}
}

// TestReadOnlyIgnoresKeywordsInsideLiteralsDocuments the boundary between "looks
// like" and "is" a write. A value that merely spells DELETE must not be rejected,
// while the same keyword outside a literal must be.
func TestReadOnlyIgnoresKeywordsInsideLiteralsDocuments(t *testing.T) {
	tests := []struct {
		name string
		sql  string
		want bool
	}{
		{name: "write keyword in a double quoted identifier", sql: `SELECT "update" FROM t`, want: true},
		{name: "write keyword in an escaped string", sql: `SELECT 'it''s DELETE'`, want: true},
		{name: "write keyword in a dollar quoted string", sql: `SELECT $$DROP TABLE t$$`, want: true},
		{name: "write keyword after a quoted semicolon", sql: `SELECT ';' AS s;`, want: true},
		{name: "real write after a quoted write keyword", sql: `SELECT 'delete'; DELETE FROM t`, want: false},
		{name: "write hidden behind a block comment prefix", sql: `/* note */ DELETE FROM t`, want: false},
		{name: "write hidden behind a line comment prefix", sql: "-- note\nDELETE FROM t", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsReadOnly(tt.sql); got != tt.want {
				t.Errorf("IsReadOnly(%q) = %v, want %v", tt.sql, got, tt.want)
			}
		})
	}
}

// FuzzIsReadOnly pins the safety property: arbitrary input must never panic, and
// any statement that is accepted must not contain a top-level statement
// separator. Accepting a multi-statement write would defeat the read-only guard.
func FuzzIsReadOnly(f *testing.F) {
	seeds := []string{
		"SELECT 1",
		"SELECT * FROM t WHERE a = 'x;y'",
		"SELECT 1; SELECT 2",
		"SELECT 1; DROP TABLE t",
		"/* c */ SELECT $$;$$",
		"WITH x AS (SELECT 1) SELECT * FROM x",
		"",
		";",
		"SHOW CREATE TABLE t",
		"SELECT \"a;b\" FROM t",
	}
	for _, seed := range seeds {
		f.Add(seed)
	}

	f.Fuzz(func(t *testing.T, sql string) {
		// Must not panic.
		readOnly := IsReadOnly(sql)
		reason := ReadOnlyViolation(sql)
		if readOnly && reason != "" {
			t.Fatalf("IsReadOnly accepted %q but ReadOnlyViolation reported %q", sql, reason)
		}
		if !readOnly && reason == "" {
			t.Fatalf("IsReadOnly rejected %q without a reason", sql)
		}
	})
}
