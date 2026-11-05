-- KWDB demo time-series database and sensor sample data for the Grafana data source.
-- KWDB does not support NOW() +/- INTERVAL expressions inside INSERT VALUES,
-- so the seed rows share a single now() timestamp.
--
-- `edge_cases` deliberately stores data shapes that are awkward for the *plugin*
-- to render correctly: a time gap larger than the selected interval, rows that
-- are not ordered by time, a NULL metric, tag values containing commas/quotes,
-- and repeated (device, site) tag combinations. It exists so the E2E suite can
-- assert on plugin-generated SQL and Data Frames, not to test KWDB itself.
CREATE TS DATABASE IF NOT EXISTS demo_ts;

CREATE TABLE IF NOT EXISTS demo_ts.sensors (
    ts TIMESTAMP NOT NULL,
    temperature DOUBLE,
    humidity DOUBLE,
    voltage DOUBLE
) TAGS (
    device_id INT NOT NULL,
    location VARCHAR(100)
) PRIMARY TAGS (device_id);

INSERT INTO demo_ts.sensors (ts, temperature, humidity, voltage, device_id, location) VALUES
    (now(), 21.4, 58.1, 219.8, 1, 'room-a'),
    (now(), 22.0, 57.6, 220.2, 2, 'room-b'),
    (now(), 21.8, 57.9, 220.0, 1, 'room-a'),
    (now(), 22.4, 57.2, 220.4, 2, 'room-b'),
    (now(), 22.1, 57.4, 220.1, 1, 'room-a'),
    (now(), 22.7, 56.9, 220.5, 2, 'room-b'),
    (now(), 22.3, 57.0, 220.2, 1, 'room-a'),
    (now(), 22.9, 56.6, 220.6, 2, 'room-b'),
    (now(), 22.5, 56.8, 220.3, 1, 'room-a'),
    (now(), 23.1, 56.4, 220.7, 2, 'room-b'),
    (now(), 22.6, 56.5, 220.3, 3, 'room-c'),
    (now(), 22.7, 56.3, 220.4, 3, 'room-c');

-- Adversarial dataset for the E2E suite. KWDB rejects expressions in
-- `INSERT ... VALUES`, so every row is inserted through `INSERT ... SELECT`;
-- `now()` is stable within one statement, which keeps the seed reproducible.
CREATE TABLE IF NOT EXISTS demo_ts.edge_cases (
    ts TIMESTAMP NOT NULL,
    value DOUBLE,
    quality INT2
) TAGS (
    device_id VARCHAR(64) NOT NULL,
    site VARCHAR(64) NOT NULL
) PRIMARY TAGS (device_id);

-- device-a has a 45 minute hole between 10:50 and 10:55 ago, so a 5m
-- downsampling query returns missing buckets and gapfill has to fill them.
INSERT INTO demo_ts.edge_cases (ts, value, quality, device_id, site)
    SELECT now() - interval '60 minutes', 10.0, 1, 'device-a', 'north'
    UNION ALL SELECT now() - interval '55 minutes', 11.0, 1, 'device-a', 'north'
    UNION ALL SELECT now() - interval '50 minutes', 12.0, 1, 'device-a', 'north'
    UNION ALL SELECT now() - interval '5 minutes', 13.0, 1, 'device-a', 'north'
    -- device-b is inserted out of time order and carries a NULL metric; the
    -- plugin must sort it and keep the NULL as a nullable field.
    UNION ALL SELECT now() - interval '5 minutes', NULL, 2, 'device-b', 'south'
    UNION ALL SELECT now() - interval '60 minutes', 20.0, 1, 'device-b', 'south'
    UNION ALL SELECT now() - interval '55 minutes', 21.0, 2, 'device-b', 'south'
    -- Tag values that need quoting: a comma (multi-value filter separator) and
    -- a single quote (SQL literal escaping).
    UNION ALL SELECT now() - interval '30 minutes', 30.0, 1, 'edge,comma', 'site''s alpha'
    -- Non-ASCII tag values, so label handling is exercised beyond ASCII.
    UNION ALL SELECT now() - interval '30 minutes', 40.0, 1, '设备-α', 'site with space';
