-- BigQuery DDL for the events dataset
CREATE SCHEMA IF NOT EXISTS `my-proj.events` OPTIONS(description="Clickstream events");

CREATE TABLE `my-proj.events.users` (
  user_id INT64 NOT NULL,
  email STRING OPTIONS(description="Login e-mail"),
  country STRING,
  signup_ts TIMESTAMP NOT NULL,
  PRIMARY KEY (user_id) NOT ENFORCED
)
PARTITION BY DATE(signup_ts)
CLUSTER BY country
OPTIONS(description="Registered users", labels=[("team", "growth")]);

CREATE TABLE `my-proj.events.clicks` (
  click_id STRING NOT NULL,
  user_id INT64,
  page STRUCT<path STRING, query_params ARRAY<STRUCT<k STRING, v STRING>>>,
  ts TIMESTAMP,
  PRIMARY KEY (click_id) NOT ENFORCED,
  CONSTRAINT fk_clicks_users FOREIGN KEY (user_id) REFERENCES `my-proj.events.users`(user_id) NOT ENFORCED
)
PARTITION BY DATE(ts);

CREATE VIEW `my-proj.events.clicks_per_country`
OPTIONS(description="Clicks by user country")
AS
SELECT u.country, COUNT(*) AS clicks, COUNT(DISTINCT c.user_id) AS users
FROM `my-proj.events.clicks` AS c
JOIN `my-proj.events.users` AS u ON u.user_id = c.user_id
WHERE c.ts >= TIMESTAMP('2024-01-01')
GROUP BY u.country;
