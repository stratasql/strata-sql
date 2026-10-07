-- Saved report queries, loads and maintenance for the shop database (PostgreSQL)
SET search_path TO sales, public;

-- 1. revenue per region and month, paid orders only
SELECT c.region,
       date_trunc('month', o.placed_at) AS month,
       sum(l.quantity * l.unit_price) AS revenue,
       count(DISTINCT o.order_id) AS order_count,
       avg(o.total) AS avg_order_value
FROM sales.orders o
JOIN sales.customer c ON c.customer_id = o.customer_id
JOIN sales.order_line l ON l.order_id = o.order_id
WHERE o.status = 'paid'
GROUP BY 1, 2
ORDER BY 2 DESC;

-- 2. the same revenue again, in another report: one metric, not two
SELECT c.full_name, sum(l.quantity * l.unit_price) AS revenue
FROM sales.orders o
JOIN sales.customer c ON c.customer_id = o.customer_id
JOIN sales.order_line l ON l.order_id = o.order_id
WHERE o.status = 'paid'
GROUP BY c.full_name;

-- 3. through a CTE
WITH paid AS (SELECT * FROM sales.orders WHERE status = 'paid')
SELECT count(*) AS paid_orders, max(total) AS biggest_order FROM paid;

-- 4. a join that no foreign key declares (order_line.product_id -> product is declared; product.sku -> stock.sku is not)
CREATE TABLE sales.stock (sku character varying(40), on_hand integer);
SELECT p.title, sum(s.on_hand) AS units_on_hand
FROM sales.product p
JOIN sales.stock s ON s.sku = p.sku
GROUP BY p.title;

-- 5. a report table
CREATE TABLE sales.daily_revenue AS
SELECT date_trunc('day', o.placed_at) AS day, sum(o.total) AS revenue
FROM sales.orders o
GROUP BY 1;

-- 6. loads
INSERT INTO sales.daily_revenue (day, revenue)
SELECT date_trunc('day', o.placed_at), sum(o.total) FROM sales.orders o WHERE o.placed_at >= now() - interval '1 day' GROUP BY 1;

MERGE INTO sales.customer_segment AS t
USING (SELECT customer_id, 1 AS segment_id FROM sales.customer WHERE loyalty > 50) AS s
ON t.customer_id = s.customer_id AND t.segment_id = s.segment_id
WHEN NOT MATCHED THEN INSERT (customer_id, segment_id) VALUES (s.customer_id, s.segment_id);

UPDATE sales.orders SET total = l.t FROM (SELECT order_id, sum(quantity * unit_price) AS t FROM sales.order_line GROUP BY order_id) l WHERE l.order_id = orders.order_id;

-- 7. sample data
INSERT INTO sales.segment (segment_id, label) VALUES (1, 'Retail'), (2, 'Wholesale'), (3, 'Partner; "special"');
INSERT INTO sales.product VALUES (1, 'A-1', 'Anvil', 99.50, NULL, NULL);

-- 8. things that are not queries
DELETE FROM sales.orders WHERE status = 'new';
VACUUM ANALYZE sales.orders;
CREATE OR REPLACE FUNCTION sales.revenue_for(c int) RETURNS numeric LANGUAGE sql AS $$ SELECT sum(total) FROM sales.orders WHERE customer_id = c; $$;
DO $$ BEGIN PERFORM 1; END $$;
