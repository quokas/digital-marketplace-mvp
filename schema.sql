CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Заказы
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key VARCHAR(255) UNIQUE, -- Защита от дублей при создании заказа фронтендом
    sku VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'created', -- created | paid | delivered | out_of_stock
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Пул цифровых ключей
CREATE TABLE digital_keys (
    id SERIAL PRIMARY KEY,
    sku VARCHAR(100) NOT NULL,
    secret_key VARCHAR(255) NOT NULL UNIQUE,
    order_id UUID REFERENCES orders(id),
    assigned_at TIMESTAMPTZ
);
CREATE INDEX idx_digital_keys_available ON digital_keys(sku) WHERE order_id IS NULL;

-- Таблица идемпотентности вебхуков
CREATE TABLE processed_webhooks (
    event_id VARCHAR(255) PRIMARY KEY,
    order_id UUID NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Промокоды
CREATE TABLE promocodes (
    code VARCHAR(50) PRIMARY KEY,
    max_uses INT NOT NULL CHECK (max_uses > 0),
    used_count INT NOT NULL DEFAULT 0 CHECK (used_count <= max_uses)
);
INSERT INTO promocodes (code, max_uses, used_count)
VALUES ('PROMO3', 3, 0)
ON CONFLICT (code) DO NOTHING;
