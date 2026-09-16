CREATE TABLE IF NOT EXISTS users(
 id BIGSERIAL PRIMARY KEY,
 email TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 is_admin BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ DEFAULT now(),
 ext_order_id TEXT UNIQUE,
 payu_order_id TEXT,
 program_id BIGINT REFERENCES programs(id)
);
CREATE TABLE IF NOT EXISTS entitlements(
 user_id BIGINT REFERENCES users(id),
 program_id BIGINT REFERENCES programs(id),
 order_id BIGINT REFERENCES orders(id),
 granted_at TIMESTAMPTZ DEFAULT now(),
 PRIMARY KEY(user_id,program_id)
);
CREATE TABLE IF NOT EXISTS programs(
 id BIGSERIAL PRIMARY KEY,
 title TEXT NOT NULL,
 category TEXT NOT NULL,
 description TEXT,
 price_pln NUMERIC(10,2) NOT NULL,
 weeks INTEGER,
 content_url TEXT,
 created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders(
 id BIGSERIAL PRIMARY KEY,
 user_id BIGINT REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'pending',
 total_pln NUMERIC(10,2) NOT NULL,
 created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items(
 order_id BIGINT REFERENCES orders(id),
 program_id BIGINT REFERENCES programs(id),
 price_pln NUMERIC(10,2) NOT NULL,
 PRIMARY KEY(order_id,program_id)
);
