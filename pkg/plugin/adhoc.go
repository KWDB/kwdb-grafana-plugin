package plugin

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/KWDB/kwdb-grafana-plugin/pkg/models"
)

// adHocFilters applies dashboard Ad Hoc filters to a single target.
//
// Grafana hands every data source one request-level Ad Hoc filter list, so a
// dashboard that mixes tables used to inject a filter about column A into a
// target reading table B, which then failed with "column does not exist"
// (issue #80). The fix is per-target: a filter is applied only when the target's
// own table declares that column, and a target whose table does not is left
// untouched instead of being filtered or erroring.
//
// The column check uses SHOW CREATE TABLE, the same metadata source as the
// Ad Hoc picker, so the answer matches what the picker offered.

// columnInfoFunc reports the columns a table declares. It is a field on the
// datasource so tests can substitute a fake catalog.
type columnInfoFunc func(ctx context.Context, table string) ([]ColumnInfo, error)

// tableTagChecker answers "does this table declare this column?" with a cache
// scoped to one request, so N targets over the same table cost one SHOW.
type tableTagChecker struct {
	lookup columnInfoFunc
	mu     sync.Mutex
	cache  map[string]map[string]struct{}
	errors map[string]error
}

func newTableTagChecker(lookup columnInfoFunc) *tableTagChecker {
	return &tableTagChecker{
		lookup: lookup,
		cache:  make(map[string]map[string]struct{}),
		errors: make(map[string]error),
	}
}

// declares reports whether `table` declares a column named `column`.
//
// Catalogue failures are returned to the caller rather than swallowed: silently
// treating an unreadable table as "does not declare the column" would skip the
// filter and return unfiltered rows.
func (c *tableTagChecker) declares(ctx context.Context, table, column string) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	key := strings.ToLower(strings.TrimSpace(table))
	if cached, ok := c.cache[key]; ok {
		_, present := cached[strings.ToLower(column)]
		return present, nil
	}
	if err, ok := c.errors[key]; ok {
		return false, err
	}

	infos, err := c.lookup(ctx, table)
	if err != nil {
		c.errors[key] = err
		return false, err
	}
	columns := make(map[string]struct{}, len(infos))
	for _, info := range infos {
		columns[strings.ToLower(info.Name)] = struct{}{}
	}
	c.cache[key] = columns
	_, present := columns[strings.ToLower(column)]
	return present, nil
}

// applicableFilters returns the predicates that apply to this target.
//
// It returns the SQL conditions to inject and whether filtering was possible at
// all. A target without a known table is reported as not applicable rather than
// guessing, because attaching a filter to an unknown table is exactly the bug
// issue #80 describes.
func (d *Datasource) applicableFilters(
	ctx context.Context,
	qm models.QueryModel,
	checker *tableTagChecker,
) (conditions []string, applicable bool, err error) {
	if len(qm.AdHocFilters) == 0 {
		return nil, true, nil
	}
	// The frontend already injected the conditions into RawSql.
	if qm.AdHocFiltered {
		return nil, false, nil
	}

	table := strings.TrimSpace(qm.Table)
	if table == "" {
		table = strings.TrimSpace(qm.AdHocTable)
	}
	if table == "" {
		// No table to check against. The target is left unchanged; the frontend
		// reports the limitation for Raw SQL it could not rewrite.
		return nil, false, nil
	}

	for _, filter := range qm.AdHocFilters {
		key := strings.TrimSpace(filter.Key)
		if key == "" || strings.TrimSpace(filter.Condition) == "" {
			continue
		}
		declared, err := checker.declares(ctx, table, key)
		if err != nil {
			return nil, false, fmt.Errorf("could not check whether %q applies to table %q: %w", key, table, err)
		}
		if declared {
			conditions = append(conditions, filter.Condition)
		}
	}
	return conditions, true, nil
}

// injectAdHocConditions adds the rendered predicates to a statement's source
// WHERE clause, mirroring the frontend's single-table rules.
//
// The backend receives the final SQL, so it only needs to handle the shapes the
// frontend can produce: a single top-level source table. Anything else is
// rejected rather than rewritten, keeping the two implementations consistent.
func injectAdHocConditions(sql string, conditions []string) (string, error) {
	if len(conditions) == 0 {
		return sql, nil
	}
	statement, ok := stripTrailingTerminator(sql)
	if !ok {
		return sql, nil
	}
	where, ok := findTopLevelWhere(statement)
	if !ok {
		return "", fmt.Errorf(
			"cannot apply Ad Hoc filters to this Raw SQL statement: it must read from a single table without joins or set operations",
		)
	}
	return where.insert(statement, conditions), nil
}

// adHocMarker tags an injected predicate so a second pass can replace it.
const adHocMarker = "/* kwdb_adhoc */"

type whereLocation struct {
	// offset is just past an existing WHERE keyword, or the position where one
	// has to be inserted.
	offset int
	has    bool
}

// insert places the marked predicates at the located position.
func (w whereLocation) insert(sql string, conditions []string) string {
	injected := adHocMarker + " " + strings.Join(conditions, " AND ")
	if w.has {
		before := sql[:w.offset]
		after := sql[w.offset:]
		return before + " " + injected + " AND" + after
	}
	before := strings.TrimRight(sql[:w.offset], " \t\r\n")
	after := strings.TrimLeft(sql[w.offset:], " \t\r\n")
	if after == "" {
		return before + "\nWHERE " + injected
	}
	return before + "\nWHERE " + injected + " " + after
}

// stripTrailingTerminator removes trailing whitespace, comments and semicolons.
//
// A terminating semicolon inside a derived clause is a syntax error and a
// trailing comment must not end up in the middle of the rewritten statement.
func stripTrailingTerminator(sql string) (string, bool) {
	statement := strings.TrimRight(sql, " \t\r\n")
	for {
		trimmed := strings.TrimRight(statement, " \t\r\n")
		if trimmed == "" {
			return "", false
		}
		if strings.HasSuffix(trimmed, ";") {
			statement = trimmed[:len(trimmed)-1]
			continue
		}
		start, ok := trailingCommentStart(trimmed)
		if !ok {
			return trimmed, true
		}
		statement = trimmed[:start]
	}
}

// trailingCommentStart returns where a comment running to the end of `sql`
// starts. Quotes and dollar quoting are skipped so a comment marker inside them
// is not treated as a comment.
func trailingCommentStart(sql string) (int, bool) {
	for i := 0; i < len(sql); {
		switch {
		case strings.HasPrefix(sql[i:], "--"):
			rest := sql[i+2:]
			idx := strings.IndexAny(rest, "\r\n")
			if idx < 0 {
				return i, true
			}
			if strings.TrimSpace(rest[idx:]) == "" {
				return i, true
			}
			i += 2 + idx
		case strings.HasPrefix(sql[i:], "/*"):
			end := skipBlockComment(sql, i)
			if strings.TrimSpace(sql[end:]) == "" {
				return i, true
			}
			i = end
		case sql[i] == '\'':
			i = skipSingleQuoted(sql, i, isEscapePrefixed(sql, i))
		case sql[i] == '"':
			i = skipDoubleQuoted(sql, i)
		case sql[i] == '$':
			if end, ok := skipDollarQuoted(sql, i); ok {
				i = end
			} else {
				i++
			}
		default:
			i++
		}
	}
	return 0, false
}

// findTopLevelWhere locates the source WHERE of a single-table statement.
//
// It returns false for joins, multiple sources, FROM subqueries, set operations
// and statements without a FROM, so the caller reports the limitation instead
// of rewriting something it does not understand.
func findTopLevelWhere(sql string) (whereLocation, bool) {
	depth := 0
	fromSeen := 0
	hasJoin := false
	hasSetOp := false
	whereAt := -1
	fromEnd := -1
	sawClauseAfterFrom := false

	for i := 0; i < len(sql); {
		switch {
		case strings.HasPrefix(sql[i:], "--"):
			rest := sql[i+2:]
			if idx := strings.IndexAny(rest, "\r\n"); idx < 0 {
				i = len(sql)
			} else {
				i += 2 + idx
			}
			continue
		case strings.HasPrefix(sql[i:], "/*"):
			i = skipBlockComment(sql, i)
			continue
		case sql[i] == '\'':
			i = skipSingleQuoted(sql, i, isEscapePrefixed(sql, i))
			continue
		case sql[i] == '"':
			i = skipDoubleQuoted(sql, i)
			continue
		case sql[i] == '$':
			if end, ok := skipDollarQuoted(sql, i); ok {
				i = end
			} else {
				i++
			}
			continue
		case sql[i] == '(':
			depth++
			i++
			continue
		case sql[i] == ')':
			depth--
			i++
			continue
		case sql[i] == ',' && depth == 0 && fromSeen > 0 && !sawClauseAfterFrom:
			// `FROM a, b` is a second source, not a column list.
			hasJoin = true
			i++
			continue
		}

		if depth == 0 && isWordByte(sql[i]) && (i == 0 || !isWordByte(sql[i-1])) {
			start := i
			for i < len(sql) && isWordByte(sql[i]) {
				i++
			}
			switch strings.ToUpper(sql[start:i]) {
			case "FROM":
				fromSeen++
			case "JOIN":
				hasJoin = true
			case "UNION", "INTERSECT", "EXCEPT":
				hasSetOp = true
			case "WHERE":
				sawClauseAfterFrom = true
				if whereAt < 0 {
					whereAt = start
				}
			case "GROUP", "ORDER", "LIMIT", "HAVING", "OFFSET", "WINDOW":
				sawClauseAfterFrom = true
				if fromEnd < 0 {
					fromEnd = start
				}
			}
			continue
		}
		i++
	}

	if fromSeen == 0 || hasJoin || hasSetOp || fromSeen > 1 {
		return whereLocation{}, false
	}
	if whereAt >= 0 {
		return whereLocation{offset: whereAt + len("WHERE"), has: true}, true
	}
	if fromEnd < 0 {
		fromEnd = len(strings.TrimRight(sql, " \t\r\n"))
	}
	return whereLocation{offset: fromEnd}, true
}

