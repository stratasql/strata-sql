-- SHOW CREATE TABLE output (Unity Catalog)
CREATE TABLE main.lake.device (
  device_id BIGINT NOT NULL COMMENT 'Serial number',
  model STRING,
  installed DATE,
  readings ARRAY<DOUBLE>,
  CONSTRAINT device_pk PRIMARY KEY (device_id)
)
USING delta
PARTITIONED BY (installed)
COMMENT 'Installed devices'
LOCATION 's3://bucket/lake/device'
TBLPROPERTIES (
  'delta.minReaderVersion' = '1',
  'delta.minWriterVersion' = '2');

CREATE TABLE main.lake.reading (
  device_id BIGINT NOT NULL,
  ts TIMESTAMP,
  value DOUBLE,
  dt STRING,
  CONSTRAINT reading_device_fk FOREIGN KEY (device_id) REFERENCES main.lake.device (device_id)
)
USING delta
PARTITIONED BY (dt STRING)
CLUSTER BY (device_id);

CREATE VIEW main.lake.hourly AS
SELECT device_id, date_trunc('HOUR', ts) AS hour, avg(value) AS avg_value, max(value) AS max_value
FROM main.lake.reading GROUP BY 1, 2;
