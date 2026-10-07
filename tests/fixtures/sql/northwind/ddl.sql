-- Northwind (classic sample database), PostgreSQL flavour
DROP TABLE IF EXISTS order_details;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS customer_customer_demo;
DROP TABLE IF EXISTS customer_demographics;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS employee_territories;
DROP TABLE IF EXISTS territories;
DROP TABLE IF EXISTS region;
DROP TABLE IF EXISTS employees;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS suppliers;
DROP TABLE IF EXISTS shippers;

CREATE TABLE categories (
    category_id smallint NOT NULL,
    category_name character varying(15) NOT NULL,
    description text,
    picture bytea,
    PRIMARY KEY (category_id)
);

CREATE TABLE customer_demographics (
    customer_type_id bpchar NOT NULL,
    customer_desc text,
    PRIMARY KEY (customer_type_id)
);

CREATE TABLE customers (
    customer_id bpchar NOT NULL,
    company_name character varying(40) NOT NULL,
    contact_name character varying(30),
    contact_title character varying(30),
    address character varying(60),
    city character varying(15),
    region character varying(15),
    postal_code character varying(10),
    country character varying(15),
    phone character varying(24),
    fax character varying(24),
    PRIMARY KEY (customer_id)
);

CREATE TABLE customer_customer_demo (
    customer_id bpchar NOT NULL,
    customer_type_id bpchar NOT NULL,
    PRIMARY KEY (customer_id, customer_type_id),
    FOREIGN KEY (customer_type_id) REFERENCES customer_demographics,
    FOREIGN KEY (customer_id) REFERENCES customers
);

CREATE TABLE employees (
    employee_id smallint NOT NULL,
    last_name character varying(20) NOT NULL,
    first_name character varying(10) NOT NULL,
    title character varying(30),
    birth_date date,
    hire_date date,
    region character varying(15),
    home_phone character varying(24),
    reports_to smallint,
    PRIMARY KEY (employee_id),
    FOREIGN KEY (reports_to) REFERENCES employees
);

CREATE TABLE region (
    region_id smallint NOT NULL,
    region_description bpchar NOT NULL,
    PRIMARY KEY (region_id)
);

CREATE TABLE territories (
    territory_id character varying(20) NOT NULL,
    territory_description bpchar NOT NULL,
    region_id smallint NOT NULL,
    PRIMARY KEY (territory_id),
    FOREIGN KEY (region_id) REFERENCES region
);

CREATE TABLE employee_territories (
    employee_id smallint NOT NULL,
    territory_id character varying(20) NOT NULL,
    PRIMARY KEY (employee_id, territory_id),
    FOREIGN KEY (territory_id) REFERENCES territories,
    FOREIGN KEY (employee_id) REFERENCES employees
);

CREATE TABLE shippers (
    shipper_id smallint NOT NULL,
    company_name character varying(40) NOT NULL,
    phone character varying(24),
    PRIMARY KEY (shipper_id)
);

CREATE TABLE suppliers (
    supplier_id smallint NOT NULL,
    company_name character varying(40) NOT NULL,
    contact_name character varying(30),
    city character varying(15),
    country character varying(15),
    PRIMARY KEY (supplier_id)
);

CREATE TABLE products (
    product_id smallint NOT NULL,
    product_name character varying(40) NOT NULL,
    supplier_id smallint,
    category_id smallint,
    quantity_per_unit character varying(20),
    unit_price real,
    units_in_stock smallint,
    units_on_order smallint,
    reorder_level smallint,
    discontinued integer NOT NULL,
    PRIMARY KEY (product_id),
    FOREIGN KEY (category_id) REFERENCES categories,
    FOREIGN KEY (supplier_id) REFERENCES suppliers
);

CREATE TABLE orders (
    order_id smallint NOT NULL,
    customer_id bpchar,
    employee_id smallint,
    order_date date,
    required_date date,
    shipped_date date,
    ship_via smallint,
    freight real,
    ship_name character varying(40),
    ship_city character varying(15),
    ship_country character varying(15),
    PRIMARY KEY (order_id),
    FOREIGN KEY (customer_id) REFERENCES customers,
    FOREIGN KEY (employee_id) REFERENCES employees,
    FOREIGN KEY (ship_via) REFERENCES shippers
);

CREATE TABLE order_details (
    order_id smallint NOT NULL,
    product_id smallint NOT NULL,
    unit_price real NOT NULL,
    quantity smallint NOT NULL,
    discount real NOT NULL,
    PRIMARY KEY (order_id, product_id),
    FOREIGN KEY (product_id) REFERENCES products,
    FOREIGN KEY (order_id) REFERENCES orders
);
