--
-- PostgreSQL database dump
--

-- Dumped from database version 16.2
-- Dumped by pg_dump version 16.2

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET default_tablespace = '';
SET default_table_access_method = heap;

CREATE SCHEMA ref;
ALTER SCHEMA ref OWNER TO shop_owner;
CREATE SCHEMA sales;
ALTER SCHEMA sales OWNER TO shop_owner;

COMMENT ON SCHEMA sales IS 'Orders and customers';

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE TYPE sales.order_status AS ENUM ('new', 'paid', 'shipped');

CREATE FUNCTION sales.touch_updated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TABLE ref.country (
    country_id integer NOT NULL,
    iso_code character(2) NOT NULL,
    name character varying(100) NOT NULL
);

CREATE SEQUENCE ref.country_country_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE sales.customer (
    customer_id integer NOT NULL,
    email character varying(255) NOT NULL,
    full_name text NOT NULL,
    country_id integer,
    region text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    loyalty numeric(5,2) DEFAULT 0.00
);

CREATE TABLE sales.product (
    product_id integer NOT NULL,
    sku character varying(40) NOT NULL,
    title text,
    price numeric(10,2) NOT NULL,
    tags text[],
    attrs jsonb
);

CREATE TABLE sales.orders (
    order_id bigint NOT NULL,
    customer_id integer NOT NULL,
    status sales.order_status DEFAULT 'new'::sales.order_status NOT NULL,
    placed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    total numeric(12,2),
    CONSTRAINT orders_total_check CHECK ((total >= (0)::numeric))
);

CREATE TABLE sales.order_line (
    order_id bigint NOT NULL,
    line_no integer NOT NULL,
    product_id integer NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    unit_price numeric(10,2) NOT NULL
);

CREATE TABLE sales.customer_segment (
    customer_id integer NOT NULL,
    segment_id integer NOT NULL
);

CREATE TABLE sales.segment (
    segment_id integer NOT NULL,
    label text NOT NULL
);

CREATE VIEW sales.revenue_by_region AS
 SELECT c.region,
    sum((l.quantity * l.unit_price)) AS revenue,
    count(DISTINCT o.order_id) AS order_count
   FROM ((sales.orders o
     JOIN sales.customer c ON ((c.customer_id = o.customer_id)))
     JOIN sales.order_line l ON ((l.order_id = o.order_id)))
  WHERE (o.status = 'paid'::sales.order_status)
  GROUP BY c.region;

COMMENT ON TABLE sales.customer IS 'People who bought something';
COMMENT ON COLUMN sales.customer.email IS 'Login e-mail, unique per customer';
COMMENT ON COLUMN sales.orders.total IS 'Order total incl. tax; it''s what the customer paid';

COPY sales.segment (segment_id, label) FROM stdin;
1	Retail
2	Wholesale
\.

ALTER TABLE ONLY ref.country
    ADD CONSTRAINT country_pkey PRIMARY KEY (country_id);

ALTER TABLE ONLY ref.country
    ADD CONSTRAINT country_iso_code_key UNIQUE (iso_code);

ALTER TABLE ONLY sales.customer
    ADD CONSTRAINT customer_pkey PRIMARY KEY (customer_id);

ALTER TABLE ONLY sales.customer
    ADD CONSTRAINT customer_email_key UNIQUE (email);

ALTER TABLE ONLY sales.product
    ADD CONSTRAINT product_pkey PRIMARY KEY (product_id);

ALTER TABLE ONLY sales.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (order_id);

ALTER TABLE ONLY sales.order_line
    ADD CONSTRAINT order_line_pkey PRIMARY KEY (order_id, line_no);

ALTER TABLE ONLY sales.customer_segment
    ADD CONSTRAINT customer_segment_pkey PRIMARY KEY (customer_id, segment_id);

ALTER TABLE ONLY sales.segment
    ADD CONSTRAINT segment_pkey PRIMARY KEY (segment_id);

CREATE INDEX orders_customer_idx ON sales.orders USING btree (customer_id);
CREATE UNIQUE INDEX product_sku_idx ON sales.product USING btree (sku);
CREATE INDEX orders_lower_status_idx ON sales.orders USING btree (lower((status)::text)) WHERE (total > (0)::numeric);

ALTER TABLE ONLY sales.customer
    ADD CONSTRAINT customer_country_fk FOREIGN KEY (country_id) REFERENCES ref.country(country_id) ON DELETE SET NULL;

ALTER TABLE ONLY sales.orders
    ADD CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES sales.customer(customer_id);

ALTER TABLE ONLY sales.order_line
    ADD CONSTRAINT order_line_order_fk FOREIGN KEY (order_id) REFERENCES sales.orders(order_id) ON DELETE CASCADE;

ALTER TABLE ONLY sales.order_line
    ADD CONSTRAINT order_line_product_fk FOREIGN KEY (product_id) REFERENCES sales.product(product_id);

ALTER TABLE ONLY sales.customer_segment
    ADD CONSTRAINT cs_customer_fk FOREIGN KEY (customer_id) REFERENCES sales.customer(customer_id);

ALTER TABLE ONLY sales.customer_segment
    ADD CONSTRAINT cs_segment_fk FOREIGN KEY (segment_id) REFERENCES sales.segment(segment_id);

CREATE TRIGGER orders_touch BEFORE UPDATE ON sales.orders FOR EACH ROW EXECUTE FUNCTION sales.touch_updated();

GRANT USAGE ON SCHEMA sales TO reporting;

--
-- PostgreSQL database dump complete
--
