-- Northwind reporting: the classic views and some saved queries (PostgreSQL)
CREATE VIEW order_subtotals AS
SELECT order_details.order_id,
       sum(order_details.unit_price * order_details.quantity * (1.0 - order_details.discount)) AS subtotal
FROM order_details
GROUP BY order_details.order_id;

CREATE VIEW sales_by_category AS
SELECT categories.category_id, categories.category_name, products.product_name,
       sum(order_details.quantity * order_details.unit_price * (1 - order_details.discount)) AS product_sales
FROM categories
JOIN products ON categories.category_id = products.category_id
JOIN order_details ON order_details.product_id = products.product_id
JOIN orders ON orders.order_id = order_details.order_id
WHERE orders.shipped_date IS NOT NULL
GROUP BY categories.category_id, categories.category_name, products.product_name;

CREATE VIEW product_list AS SELECT p.product_id, p.product_name, p.discontinued FROM products p WHERE p.discontinued = 0;

CREATE VIEW orders_qry AS
SELECT o.*, c.company_name, c.city FROM orders o JOIN customers c ON c.customer_id = o.customer_id;

-- Employee sales by country
SELECT e.country_dummy, e.last_name FROM employees e WHERE false;

SELECT o.ship_country, count(o.order_id) AS orders, sum(od.quantity) AS units
FROM orders o, order_details od
WHERE o.order_id = od.order_id AND o.order_date >= '1997-01-01'
GROUP BY o.ship_country;

INSERT INTO shippers (shipper_id, company_name, phone) VALUES (1, 'Speedy Express', '(503) 555-9831'), (2, 'United Package', '(503) 555-3199');
