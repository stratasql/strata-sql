-- GET_DDL('SCHEMA', 'ANALYTICS.CORE') output, plus the database and schema statements around it
create or replace database ANALYTICS;
use database ANALYTICS;
create or replace schema ANALYTICS.CORE comment = 'Core warehouse tables';
use schema ANALYTICS.CORE;

create or replace TABLE ACCOUNT (
	ACCOUNT_ID NUMBER(38,0) NOT NULL,
	NAME VARCHAR(16777216) NOT NULL COMMENT 'Legal name',
	TIER VARCHAR(20) DEFAULT 'STANDARD',
	META VARIANT,
	CREATED_AT TIMESTAMP_NTZ(9) DEFAULT CURRENT_TIMESTAMP(),
	constraint PK_ACCOUNT primary key (ACCOUNT_ID)
) cluster by (TIER) comment='Customer accounts' data_retention_time_in_days=7;

create or replace TABLE INVOICE (
	INVOICE_ID NUMBER(38,0) NOT NULL autoincrement start 1 increment 1 order,
	ACCOUNT_ID NUMBER(38,0) NOT NULL,
	AMOUNT NUMBER(12,2),
	ISSUED DATE,
	constraint PK_INVOICE primary key (INVOICE_ID),
	constraint FK_INVOICE_ACCOUNT foreign key (ACCOUNT_ID) references ANALYTICS.CORE.ACCOUNT(ACCOUNT_ID)
);

create or replace TRANSIENT TABLE STAGE_INVOICE (
	RAW VARIANT
);

create or replace view OPEN_INVOICES(
	INVOICE_ID,
	ACCOUNT_NAME,
	AMOUNT
) as
select i.INVOICE_ID, a.NAME, i.AMOUNT
from ANALYTICS.CORE.INVOICE i
join ANALYTICS.CORE.ACCOUNT a on a.ACCOUNT_ID = i.ACCOUNT_ID
where i.ISSUED is not null;

create or replace secure view TOP_ACCOUNTS as
select a.NAME, sum(i.AMOUNT) as TOTAL
from ANALYTICS.CORE.INVOICE i join ANALYTICS.CORE.ACCOUNT a on a.ACCOUNT_ID = i.ACCOUNT_ID
group by a.NAME qualify row_number() over (order by sum(i.AMOUNT) desc) <= 10;

comment on table ANALYTICS.CORE.INVOICE is 'One row per issued invoice';
comment on column ANALYTICS.CORE.INVOICE.AMOUNT is 'Net amount in EUR';

create or replace procedure CLOSE_MONTH() returns varchar language javascript as
$$
  var rs = snowflake.execute({sqlText: "select 1; select 2"});
  return 'done';
$$;
