package plugin

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

type columnKind int

const (
	kindString columnKind = iota
	kindInt64
	kindInt32
	kindFloat64
	kindBool
	kindTime
)

type columnPlan struct {
	name   string
	oid    uint32
	kind   columnKind
	values []any
	labels data.Labels
}

// DefaultMaxRows caps the number of rows buffered into a single frame.
const DefaultMaxRows = 100000

// FrameOptions controls how pgx result rows are converted into Grafana frames.
type FrameOptions struct {
	// Format is either "time_series" or "table".
	Format string
	// Mode is the query builder mode ("downsampling", "gapfill", "latest",
	// "window", "raw"). Tag-based frame splitting only applies to "latest".
	Mode string
	// TimeColumn optionally names the time column used for detection.
	TimeColumn string
	// Tags lists tag columns used to split latest-value results into one
	// frame per distinct tag combination.
	Tags []string
	// SplitByTag disables tag-based frame splitting when set to false;
	// nil or true splits latest-values results per tag combination.
	SplitByTag *bool
	// MaxRows caps the number of buffered rows; zero or negative disables the cap.
	MaxRows int
	// OnTruncate is called once when the row cap is reached, before the result
	// set is drained. It lets the caller cancel the query so the database stops
	// computing rows that will never be returned.
	OnTruncate func()
}

// RowsToFrame converts pgx result rows into a single Grafana Data Frame.
func RowsToFrame(rows pgx.Rows, format string, timeColumn string, tags []string) (*data.Frame, error) {
	frames, err := RowsToFrames(rows, FrameOptions{Format: format, TimeColumn: timeColumn, Tags: tags, MaxRows: DefaultMaxRows})
	if err != nil {
		return nil, err
	}
	return frames[0], nil
}

// RowsToFrames converts pgx result rows into one or more Grafana Data Frames.
// Latest-values queries grouped by tags produce one frame per tag combination
// so visualization panels show a separate series for every group.
func RowsToFrames(rows pgx.Rows, opts FrameOptions) ([]*data.Frame, error) {
	defer rows.Close()

	maxRows := opts.MaxRows
	plans, truncated, err := scanPlans(rows, maxRows)
	if err != nil {
		return nil, err
	}
	if truncated && opts.OnTruncate != nil {
		opts.OnTruncate()
	}
	plans = dropEmptyLatestAggregateRows(plans, opts)

	if opts.Format == "time_series" {
		frame, err := timeSeriesFrame(plans, opts.TimeColumn, opts.Tags)
		if err != nil {
			return nil, err
		}
		if truncated {
			applyMaxRowsNotice(frame, maxRows)
		}
		return []*data.Frame{frame}, nil
	}

	if frames := splitLatestFrames(plans, opts); frames != nil {
		if truncated {
			for _, frame := range frames {
				applyMaxRowsNotice(frame, maxRows)
			}
		}
		return frames, nil
	}

	frame := newFrameFromPlans(plans)
	if truncated {
		applyMaxRowsNotice(frame, maxRows)
	}
	return []*data.Frame{frame}, nil
}

// scanPlans buffers all result rows into typed column plans.
func scanPlans(rows pgx.Rows, maxRows int) ([]columnPlan, bool, error) {
	descriptions := rows.FieldDescriptions()
	plans := make([]columnPlan, len(descriptions))
	for i, fd := range descriptions {
		plans[i] = columnPlan{
			name: fd.Name,
			oid:  fd.DataTypeOID,
			kind: kindForOID(fd.DataTypeOID),
		}
	}

	truncated := false
	rowCount := 0
	for rows.Next() {
		if maxRows > 0 && rowCount >= maxRows {
			truncated = true
			break
		}
		values, err := rows.Values()
		if err != nil {
			return nil, false, err
		}
		if len(values) != len(plans) {
			return nil, false, fmt.Errorf("row has %d values but %d fields were described", len(values), len(plans))
		}
		for i := range plans {
			value, err := convertValue(plans[i].kind, values[i])
			if err != nil {
				return nil, false, fmt.Errorf("column %q: %w", plans[i].name, err)
			}
			plans[i].values = append(plans[i].values, value)
		}
		rowCount++
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return plans, truncated, nil
}

// timeSeriesFrame converts buffered plans into a wide time-series frame.
func timeSeriesFrame(plans []columnPlan, timeColumn string, tags []string) (*data.Frame, error) {
	timeIdx, err := prepareTimeSeries(plans, timeColumn, tags)
	if err != nil {
		return nil, err
	}
	plans = moveTimeFirst(plans, timeIdx)

	frame := newFrameFromPlans(plans)
	rowLen, err := frame.RowLen()
	if err != nil {
		return nil, err
	}
	if rowLen == 0 {
		return frame, nil
	}
	switch frame.TimeSeriesSchema().Type {
	case data.TimeSeriesTypeLong:
		return data.LongToWide(frame, nil)
	case data.TimeSeriesTypeWide:
		return frame, nil
	default:
		return nil, fmt.Errorf("could not convert frame to time series")
	}
}

// newFrameFromPlans builds a plain frame from buffered column plans.
func newFrameFromPlans(plans []columnPlan) *data.Frame {
	frame := data.NewFrame("response")
	for _, plan := range plans {
		frame.Fields = append(frame.Fields, buildField(plan))
	}
	return frame
}

func applyMaxRowsNotice(frame *data.Frame, maxRows int) {
	if frame.Meta == nil {
		frame.Meta = &data.FrameMeta{}
	}
	frame.Meta.Notices = append(frame.Meta.Notices, data.Notice{
		Severity: data.NoticeSeverityWarning,
		Text:     fmt.Sprintf("Query result was truncated at %d rows read; add LIMIT or narrow the time range to see all data", maxRows),
	})
}

// dropEmptyLatestAggregateRows removes the NULL-time rows KWDB returns for a
// Latest Values query whose time range contains no rows.
//
// KWDB keeps aggregate rows for an empty input even when GROUP BY is applied:
// without tags it returns one row with every column NULL, and with tags it
// returns one row per tag where only the tag columns are non-NULL. Passing any
// of those rows to the time-series conversion fails with
// `time column "time" contains NULL values` and the panel shows a plugin error
// where it should show "No data" (issue #83).
//
// A row is only dropped when its time is NULL and every non-tag field is NULL
// as well. A NULL time next to a real value is a genuine data problem and keeps
// its error; a real time with a NULL metric is a valid data point and is kept.
func dropEmptyLatestAggregateRows(plans []columnPlan, opts FrameOptions) []columnPlan {
	if opts.Mode != "latest" || len(plans) == 0 {
		return plans
	}
	timeIdx, err := findTimeColumn(plans, opts.TimeColumn)
	if err != nil {
		return plans
	}

	tagIdx := make(map[int]bool, len(opts.Tags))
	for _, tag := range opts.Tags {
		if idx := findColumnFold(plans, tag); idx >= 0 {
			tagIdx[idx] = true
		}
	}

	keep := make([]int, 0, len(plans[timeIdx].values))
	for row, value := range plans[timeIdx].values {
		if value == nil && latestRowHasNoValues(plans, row, timeIdx, tagIdx) {
			continue
		}
		keep = append(keep, row)
	}
	if len(keep) == len(plans[timeIdx].values) {
		return plans
	}
	for i := range plans {
		plans[i].values = pickRows(plans[i].values, keep)
	}
	return plans
}

// latestRowHasNoValues reports whether every non-time, non-tag column is NULL
// on one row.
func latestRowHasNoValues(plans []columnPlan, row, timeIdx int, tagIdx map[int]bool) bool {
	for i, plan := range plans {
		if i == timeIdx || tagIdx[i] {
			continue
		}
		if plan.values[row] != nil {
			return false
		}
	}
	return true
}

// tagRef pairs a resolved column index with its tag name.
type tagRef struct {
	idx  int
	name string
}

// latestGroup accumulates the row indexes sharing one tag combination.
type latestGroup struct {
	sortValues []string
	display    []string
	rows       []int
}

// splitLatestFrames splits latest-values results into one frame per distinct
// tag combination so panels such as Gauge and Stat render a separate series
// for every group. Every column is kept in each frame; the frame name carries
// the tag identity (e.g. "CNC-001") so field labels are left empty to avoid
// duplication in display names. It returns nil when splitting does not apply.
func splitLatestFrames(plans []columnPlan, opts FrameOptions) []*data.Frame {
	if opts.SplitByTag != nil && !*opts.SplitByTag {
		return nil
	}
	if opts.Mode != "latest" || len(opts.Tags) == 0 || len(plans) == 0 || len(plans[0].values) == 0 {
		return nil
	}

	refs := make([]tagRef, 0, len(opts.Tags))
	for _, tag := range opts.Tags {
		idx := findColumnFold(plans, tag)
		if idx < 0 {
			return nil
		}
		refs = append(refs, tagRef{idx: idx, name: plans[idx].name})
	}

	rowCount := len(plans[0].values)
	groups := make(map[string]*latestGroup, rowCount)
	keys := make([]string, 0, rowCount)
	for row := 0; row < rowCount; row++ {
		g := &latestGroup{}
		for _, ref := range refs {
			value := planValueString(plans[ref.idx].values[row])
			g.sortValues = append(g.sortValues, value)
			g.display = append(g.display, ref.name+"="+value)
		}
		key := strings.Join(g.sortValues, "\x1f")
		if existing, ok := groups[key]; ok {
			existing.rows = append(existing.rows, row)
			continue
		}
		g.rows = append(g.rows, row)
		groups[key] = g
		keys = append(keys, key)
	}
	sort.Strings(keys)

	frames := make([]*data.Frame, 0, len(keys))
	for _, key := range keys {
		g := groups[key]
		name := g.display[0][strings.IndexByte(g.display[0], '=')+1:]
		if len(refs) > 1 {
			name = strings.Join(g.display, ", ")
		}
		frame := data.NewFrame(name)
		for i := range plans {
			plan := plans[i]
			plan.values = pickRows(plan.values, g.rows)
			frame.Fields = append(frame.Fields, buildField(plan))
		}
		frames = append(frames, frame)
	}
	return frames
}

func findColumnFold(plans []columnPlan, name string) int {
	for i := range plans {
		if strings.EqualFold(plans[i].name, name) {
			return i
		}
	}
	return -1
}

func planValueString(v any) string {
	if v == nil {
		return ""
	}
	switch s := v.(type) {
	case string:
		return s
	case []byte:
		return string(s)
	default:
		return fmt.Sprint(v)
	}
}

func pickRows(values []any, rows []int) []any {
	out := make([]any, len(rows))
	for i, row := range rows {
		out[i] = values[row]
	}
	return out
}

func kindForOID(oid uint32) columnKind {
	switch oid {
	case 20, 21:
		return kindInt64
	case 23, 26:
		return kindInt32
	case 700, 701:
		return kindFloat64
	case 1700:
		return kindFloat64
	case 16:
		return kindBool
	// timestamp, timestamptz, date and time are all plotted on the time axis.
	case 1082, 1083, 1114, 1184:
		return kindTime
	case 25, 1043:
		return kindString
	default:
		// uuid, interval, json, jsonb, bytea, arrays and other exotic types are
		// rendered through convertValue's readable string form so a table never
		// shows raw Go values such as [26 34 100 ...].
		return kindString
	}
}

// stringifyValue renders non-string database values in a readable form for
// table output.
func stringifyValue(v any) string {
	switch value := v.(type) {
	case nil:
		return ""
	case string:
		return value
	case []byte:
		return string(value)
	case time.Time:
		return value.UTC().Format(time.RFC3339Nano)
	case [16]byte:
		return formatUUID(value)
	case pgtype.Interval:
		return formatInterval(value)
	case pgtype.Time:
		if !value.Valid {
			return ""
		}
		return time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC).
			Add(time.Duration(value.Microseconds) * time.Microsecond).Format("15:04:05.999999")
	default:
		return fmt.Sprint(v)
	}
}

func formatUUID(b [16]byte) string {
	const hex = "0123456789abcdef"
	var out [36]byte
	pos := 0
	for i, by := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			out[pos] = '-'
			pos++
		}
		out[pos] = hex[by>>4]
		out[pos+1] = hex[by&0x0f]
		pos += 2
	}
	return string(out[:])
}

func formatInterval(v pgtype.Interval) string {
	if !v.Valid {
		return ""
	}
	parts := make([]string, 0, 3)
	if v.Months != 0 {
		parts = append(parts, fmt.Sprintf("%d mons", v.Months))
	}
	if v.Days != 0 {
		parts = append(parts, fmt.Sprintf("%d days", v.Days))
	}
	if v.Microseconds != 0 {
		parts = append(parts, (time.Duration(v.Microseconds) * time.Microsecond).String())
	}
	if len(parts) == 0 {
		return "00:00:00"
	}
	return strings.Join(parts, " ")
}

func convertValue(kind columnKind, v any) (any, error) {
	if v == nil {
		return nil, nil
	}
	switch kind {
	case kindInt64:
		switch n := v.(type) {
		case int64:
			return n, nil
		case int32:
			return int64(n), nil
		case int16:
			return int64(n), nil
		case int:
			return int64(n), nil
		case float64:
			return int64(n), nil
		}
		return nil, fmt.Errorf("cannot convert %T to int64", v)
	case kindInt32:
		switch n := v.(type) {
		case int32:
			return n, nil
		case int16:
			return int32(n), nil
		case int64:
			if n < math.MinInt32 || n > math.MaxInt32 {
				return nil, fmt.Errorf("cannot convert %d to int32", n)
			}
			return int32(n), nil
		case uint32:
			if n > math.MaxInt32 {
				return nil, fmt.Errorf("cannot convert %d to int32", n)
			}
			return int32(n), nil
		case int:
			if n < math.MinInt32 || n > math.MaxInt32 {
				return nil, fmt.Errorf("cannot convert %d to int32", n)
			}
			return int32(n), nil
		}
		return nil, fmt.Errorf("cannot convert %T to int32", v)
	case kindFloat64:
		switch n := v.(type) {
		case float64:
			return n, nil
		case float32:
			return float64(n), nil
		case pgtype.Numeric:
			f, err := n.Float64Value()
			if err != nil {
				return nil, fmt.Errorf("cannot convert numeric: %w", err)
			}
			if !f.Valid {
				return nil, nil
			}
			return f.Float64, nil
		case int64:
			return float64(n), nil
		case int32:
			return float64(n), nil
		case int16:
			return float64(n), nil
		}
		return nil, fmt.Errorf("cannot convert %T to float64", v)
	case kindBool:
		if b, ok := v.(bool); ok {
			return b, nil
		}
		return nil, fmt.Errorf("cannot convert %T to bool", v)
	case kindString:
		return stringifyValue(v), nil
	case kindTime:
		if t, ok := v.(time.Time); ok {
			return t, nil
		}
		if t, ok := v.(pgtype.Time); ok && t.Valid {
			return time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(t.Microseconds) * time.Microsecond), nil
		}
		return nil, fmt.Errorf("cannot convert %T to time.Time", v)
	}
	return nil, fmt.Errorf("unsupported column kind %d", kind)
}

// prepareTimeSeries normalises the plans for a time-series frame: it resolves
// the time column, rejects NULL times, sorts the rows by time and renames the
// column to "time". It returns the index of the time column.
func prepareTimeSeries(plans []columnPlan, timeColumn string, tags []string) (int, error) {
	timeIdx, err := findTimeColumn(plans, timeColumn)
	if err != nil {
		return -1, err
	}
	if err := ensureNoNullTimes(plans[timeIdx]); err != nil {
		return -1, err
	}
	sortPlansByTime(plans, timeIdx)
	plans[timeIdx].name = "time"

	if len(tags) > 0 {
		for i := range plans {
			if containsFold(tags, plans[i].name) {
				plans[i].labels = data.Labels{}
			}
		}
	}
	return timeIdx, nil
}

// moveTimeFirst puts the time column at the head of the frame.
//
// A Grafana time series frame must lead with its time field. Statements do not
// have to list the time column first - the latest-values builder deliberately
// selects the metrics before it - and while data.LongToWide hoists the time
// field for long frames, a frame without string/bool columns is already "wide"
// and is returned untouched, which would leave the time field last and make
// Grafana treat the result as a table.
func moveTimeFirst(plans []columnPlan, timeIdx int) []columnPlan {
	if timeIdx <= 0 {
		return plans
	}
	reordered := make([]columnPlan, 0, len(plans))
	reordered = append(reordered, plans[timeIdx])
	for i, plan := range plans {
		if i == timeIdx {
			continue
		}
		reordered = append(reordered, plan)
	}
	return reordered
}

// kindName renders a column kind for error messages.
func kindName(kind columnKind) string {
	switch kind {
	case kindInt64:
		return "integer"
	case kindInt32:
		return "integer"
	case kindFloat64:
		return "number"
	case kindBool:
		return "boolean"
	case kindTime:
		return "timestamp"
	default:
		return "string"
	}
}

func findTimeColumn(plans []columnPlan, timeColumn string) (int, error) {
	if timeColumn != "" {
		for i := range plans {
			if strings.EqualFold(plans[i].name, timeColumn) {
				if plans[i].kind != kindTime {
					return -1, fmt.Errorf("configured time column %q is not a timestamp column (its type maps to %s); set Time column to a timestamp field or use Table format",
						plans[i].name, kindName(plans[i].kind))
				}
				return i, nil
			}
		}
		// Builder modes bucket the time column and alias it to "time", so the
		// configured source column legitimately does not appear in the result.
		for i := range plans {
			if plans[i].kind == kindTime && strings.EqualFold(plans[i].name, "time") {
				return i, nil
			}
		}
		return -1, fmt.Errorf("configured time column %q was not returned by the query and no \"time\" column was found; available columns: %s",
			timeColumn, strings.Join(columnNames(plans), ", "))
	}
	for i := range plans {
		if plans[i].kind == kindTime {
			return i, nil
		}
	}
	return -1, fmt.Errorf("time_series format requires a time column; available columns: %s (select Table format for non-time results)",
		strings.Join(columnNames(plans), ", "))
}

// ensureNoNullTimes fails with a readable error when the time column contains
// NULL values, which the Grafana time series conversion cannot represent.
func ensureNoNullTimes(plan columnPlan) error {
	for row, value := range plan.values {
		if value == nil {
			return fmt.Errorf("time column %q contains NULL values (row %d); filter them out with a WHERE clause or use Table format", plan.name, row+1)
		}
	}
	return nil
}

func columnNames(plans []columnPlan) []string {
	names := make([]string, len(plans))
	for i := range plans {
		names[i] = plans[i].name
	}
	return names
}

func sortPlansByTime(plans []columnPlan, timeIdx int) {
	times := plans[timeIdx].values
	order := make([]int, len(times))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(i, j int) bool {
		return asTime(times[order[i]]).Before(asTime(times[order[j]]))
	})
	for i := range plans {
		values := plans[i].values
		reordered := make([]any, len(values))
		for j, src := range order {
			reordered[j] = values[src]
		}
		plans[i].values = reordered
	}
}

func asTime(v any) time.Time {
	if t, ok := v.(time.Time); ok {
		return t
	}
	return time.Time{}
}

func containsFold(items []string, target string) bool {
	for _, item := range items {
		if strings.EqualFold(item, target) {
			return true
		}
	}
	return false
}

func buildField(plan columnPlan) *data.Field {
	if plan.labels != nil && plan.kind != kindTime && plan.kind != kindString {
		return buildTagField(plan)
	}
	if hasNil(plan.values) {
		return buildNullableField(plan)
	}
	switch plan.kind {
	case kindInt64:
		return data.NewField(plan.name, plan.labels, asValues[int64](plan.values))
	case kindInt32:
		return data.NewField(plan.name, plan.labels, asValues[int32](plan.values))
	case kindFloat64:
		return data.NewField(plan.name, plan.labels, asValues[float64](plan.values))
	case kindBool:
		return data.NewField(plan.name, plan.labels, asValues[bool](plan.values))
	case kindTime:
		return data.NewField(plan.name, plan.labels, asValues[time.Time](plan.values))
	default:
		return data.NewField(plan.name, plan.labels, asValues[string](plan.values))
	}
}

func buildTagField(plan columnPlan) *data.Field {
	if hasNil(plan.values) {
		values := make([]*string, len(plan.values))
		for i, v := range plan.values {
			if v != nil {
				s := fmt.Sprint(v)
				values[i] = &s
			}
		}
		return data.NewField(plan.name, plan.labels, values)
	}
	values := make([]string, len(plan.values))
	for i, v := range plan.values {
		values[i] = fmt.Sprint(v)
	}
	return data.NewField(plan.name, plan.labels, values)
}

func hasNil(values []any) bool {
	for _, v := range values {
		if v == nil {
			return true
		}
	}
	return false
}

func asValues[T any](values []any) []T {
	out := make([]T, len(values))
	for i, v := range values {
		out[i] = v.(T)
	}
	return out
}

func buildNullableField(plan columnPlan) *data.Field {
	switch plan.kind {
	case kindInt64:
		values := make([]*int64, len(plan.values))
		for i, v := range plan.values {
			if n, ok := v.(int64); ok {
				n := n
				values[i] = &n
			}
		}
		return data.NewField(plan.name, plan.labels, values)
	case kindInt32:
		values := make([]*int32, len(plan.values))
		for i, v := range plan.values {
			if n, ok := v.(int32); ok {
				n := n
				values[i] = &n
			}
		}
		return data.NewField(plan.name, plan.labels, values)
	case kindFloat64:
		values := make([]*float64, len(plan.values))
		for i, v := range plan.values {
			if n, ok := v.(float64); ok {
				n := n
				values[i] = &n
			}
		}
		return data.NewField(plan.name, plan.labels, values)
	case kindBool:
		values := make([]*bool, len(plan.values))
		for i, v := range plan.values {
			if b, ok := v.(bool); ok {
				b := b
				values[i] = &b
			}
		}
		return data.NewField(plan.name, plan.labels, values)
	case kindTime:
		values := make([]*time.Time, len(plan.values))
		for i, v := range plan.values {
			if t, ok := v.(time.Time); ok {
				t := t
				values[i] = &t
			}
		}
		return data.NewField(plan.name, plan.labels, values)
	default:
		values := make([]*string, len(plan.values))
		for i, v := range plan.values {
			if s, ok := v.(string); ok {
				s := s
				values[i] = &s
			}
		}
		return data.NewField(plan.name, plan.labels, values)
	}
}
