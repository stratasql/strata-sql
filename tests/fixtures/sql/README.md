# SQL fixtures for tests/sqlimport.check.js

All files are HAND-WRITTEN from knowledge of what each tool writes (pg_dump, mysqldump, SSMS "Script Table as", Snowflake GET_DDL, BigQuery DDL, Databricks
SHOW CREATE TABLE, Oracle DBMS_METADATA), not captured from real databases. They follow the real layouts closely (comments, SET lines, ownership statements,
conditional comments, GO batches) but real dumps of your own database will contain things these do not.
