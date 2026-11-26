CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Заказы
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key VARCHAR(255) UNIQUE,
    sku VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'created'
        CHECK (status IN ('created', 'paid', 'delivered', 'out_of_stock')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Индекс для быстрой выборки последних заказов на витрине
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);

-- 2. Пул цифровых ключей
CREATE TABLE IF NOT EXISTS digital_keys (
    id BIGSERIAL PRIMARY KEY,
    sku VARCHAR(100) NOT NULL,
    secret_key VARCHAR(255) NOT NULL UNIQUE,
    order_id UUID REFERENCES orders(id) ON DELETE RESTRICT,
    assigned_at TIMESTAMPTZ
);

-- Частичный индекс для мгновенного поиска свободных ключей (FOR UPDATE SKIP LOCKED)
CREATE INDEX IF NOT EXISTS idx_digital_keys_available
    ON digital_keys (sku)
    WHERE order_id IS NULL;

-- Частичный уникальный индекс: ускоряет JOIN по order_id и гарантирует правило "1 заказ = максимум 1 ключ"
CREATE UNIQUE INDEX IF NOT EXISTS idx_digital_keys_order_id
    ON digital_keys (order_id)
    WHERE order_id IS NOT NULL;

-- 3. Таблица идемпотентности вебхуков
CREATE TABLE IF NOT EXISTS processed_webhooks (
    event_id VARCHAR(255) PRIMARY KEY,
    order_id UUID NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_webhooks_order_id ON processed_webhooks (order_id);

-- 4. Промокоды
CREATE TABLE IF NOT EXISTS promocodes (
    code VARCHAR(50) PRIMARY KEY,
    max_uses INT NOT NULL CHECK (max_uses > 0),
    used_count INT NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses)
);

INSERT INTO promocodes (code, max_uses, used_count)
VALUES ('PROMO3', 3, 0)
ON CONFLICT (code) DO NOTHING;

-- 5. Transactional Outbox для гарантированной отправки событий
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(50) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processed', 'failed')),
    attempts INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- Воркер сканирует только необработанные события
CREATE INDEX IF NOT EXISTS idx_outbox_pending
    ON outbox_events (created_at ASC)
    WHERE status = 'pending';
