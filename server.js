require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const { z } = require('zod');

const app = express();
app.use(express.static('public'));
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!WEBHOOK_SECRET || !process.env.DATABASE_URL) {
  console.error('FATAL: WEBHOOK_SECRET и DATABASE_URL обязательны в .env');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
});

// Сохраняем rawBody для честной проверки HMAC-SHA256 подписи
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));

// Схемы валидации (Zod)
const createOrderSchema = z.object({
  sku: z.string().min(1).max(100),
  idempotency_key: z.string().min(1).max(255).optional(),
});

const webhookSchema = z.object({
  event_id: z.string().min(1).max(255),
  order_id: z.string().uuid(),
  status: z.enum(['paid', 'failed', 'pending']),
});

const refillSchema = z.object({
  sku: z.string().min(1).max(100),
  keys: z.array(z.string().min(1)).min(1),
});

const promoSchema = z.object({
  code: z.string().min(1).max(50),
});

// Middleware проверки HMAC подписи вебхука (защита от подделки запросов)
function verifyWebhookSignature(req, res, next) {
  const signature = req.headers['x-signature'];
  if (!signature || typeof signature !== 'string' || !req.rawBody) {
    return res.status(401).json({ error: 'Missing webhook signature' });
  }

  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');

  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  next();
}

// 1. Создание заказа (с защитой от дублей фронтенда через idempotency_key)
app.post('/api/orders', async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { sku, idempotency_key } = parsed.data;

  try {
    if (idempotency_key) {
      const result = await pool.query(
        `INSERT INTO orders (sku, idempotency_key)
         VALUES ($1, $2)
         ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = NOW()
         RETURNING id, sku, status`,
        [sku, idempotency_key]
      );
      return res.status(201).json(result.rows[0]);
    }

    const result = await pool.query(
      `INSERT INTO orders (sku) VALUES ($1) RETURNING id, sku, status`,
      [sku]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create order error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Получение заказа вместе с выданным ключом
app.get('/api/orders/:id', async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    return res.status(400).json({ error: 'Invalid order UUID' });
  }

  try {
    const result = await pool.query(
      `SELECT o.id, o.sku, o.status, o.created_at, dk.secret_key AS key
       FROM orders o
       LEFT JOIN digital_keys dk ON dk.order_id = o.id
       WHERE o.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Get order error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
// Вспомогательная функция: атомарная выдача ключа внутри открытой транзакции
async function assignKeyInTx(client, orderId, sku) {
  const keyRes = await client.query(
    `SELECT id, secret_key FROM digital_keys
     WHERE sku = $1 AND order_id IS NULL
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [sku]
  );

  if (keyRes.rows.length === 0) {
    await client.query(
      `UPDATE orders SET status = 'out_of_stock', updated_at = NOW() WHERE id = $1`,
      [orderId]
    );
    return { status: 'out_of_stock', key: null };
  }

  const pickedKey = keyRes.rows[0];
  await client.query(
    `UPDATE digital_keys SET order_id = $1, assigned_at = NOW() WHERE id = $2`,
    [orderId, pickedKey.id]
  );
  await client.query(
    `UPDATE orders SET status = 'delivered', updated_at = NOW() WHERE id = $1`,
    [orderId]
  );

  return { status: 'delivered', key: pickedKey.secret_key };
}

// 2. Вебхук оплаты (HMAC + Идемпотентность + ACID-транзакция + FOR UPDATE)
app.post('/webhook/payment', verifyWebhookSignature, async (req, res) => {
  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { event_id, order_id, status } = parsed.data;
  if (status !== 'paid') return res.sendStatus(200);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Идемпотентность: отсекаем сетевые дубли одного event_id
    const eventRes = await client.query(
      `INSERT INTO processed_webhooks (event_id, order_id)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event_id, order_id]
    );

    if (eventRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(200).send('OK (Duplicate event)');
    }

    // Пессимистичная блокировка заказа от параллельных разных оплат
    const orderRes = await client.query(
      `SELECT id, sku, status FROM orders WHERE id = $1 FOR UPDATE`,
      [order_id]
    );

    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderRes.rows[0];
    if (order.status !== 'created') {
      await client.query('COMMIT');
      return res.status(409).json({ error: 'Order already processed' });
    }

    await client.query(`UPDATE orders SET status = 'paid', updated_at = NOW() WHERE id = $1`, [order_id]);
    const delivery = await assignKeyInTx(client, order_id, order.sku);

    await client.query('COMMIT');
    return res.status(200).json({ ok: true, status: delivery.status });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Webhook transaction error:', err);
    return res.status(500).json({ error: 'Transaction failed' });
  } finally {
    client.release();
  }
});
// 3. Повторная выдача после пополнения пула (out_of_stock -> delivered)
app.post('/api/orders/:id/retry', async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    return res.status(400).json({ error: 'Invalid order UUID' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query(
      `SELECT id, sku, status FROM orders WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );

    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderRes.rows[0];
    if (order.status !== 'out_of_stock') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot retry order in status: ${order.status}` });
    }

    const delivery = await assignKeyInTx(client, order.id, order.sku);
    await client.query('COMMIT');
    return res.json(delivery);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Retry error:', err);
    return res.status(500).json({ error: 'Retry failed' });
  } finally {
    client.release();
  }
});

// 4. Массовое пополнение пула ключей (через UNNEST за 1 запрос)
app.post('/api/admin/refill', async (req, res) => {
  const parsed = refillSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { sku, keys } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO digital_keys (sku, secret_key)
       SELECT $1, unnest($2::text[])
       ON CONFLICT (secret_key) DO NOTHING`,
      [sku, keys]
    );
    return res.json({ success: true, inserted: result.rowCount });
  } catch (err) {
    console.error('Refill error:', err);
    return res.status(500).json({ error: 'Refill failed' });
  }
});

// 5. Атомарное применение промокода (защита от Race Conditions без мьютексов)
app.post('/api/promocodes/apply', async (req, res) => {
  const parsed = promoSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const result = await pool.query(
      `UPDATE promocodes
       SET used_count = used_count + 1
       WHERE code = $1 AND used_count < max_uses
       RETURNING code, used_count, max_uses`,
      [parsed.data.code]
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ error: 'Промокод не найден или лимит исчерпан' });
    }
    return res.json({ success: true, promo: result.rows[0] });
  } catch (err) {
    console.error('Promo error:', err);
    return res.status(500).json({ error: 'Promo apply failed' });
  }
});
// 6. Получение остатков ключей и статуса промокода для витрины
app.get('/api/store/state', async (_req, res) => {
  try {
    const stockRes = await pool.query(
      `SELECT sku, COUNT(*)::int AS available
       FROM digital_keys
       WHERE order_id IS NULL
       GROUP BY sku`
    );
    const promoRes = await pool.query(`SELECT code, used_count, max_uses FROM promocodes`);
    const ordersRes = await pool.query(
      `SELECT o.id, o.sku, o.status, o.created_at, dk.secret_key AS key
       FROM orders o
       LEFT JOIN digital_keys dk ON dk.order_id = o.id
       ORDER BY o.created_at DESC
       LIMIT 10`
    );

    res.json({
      stock: Object.fromEntries(stockRes.rows.map((r) => [r.sku, r.available])),
      promocodes: promoRes.rows,
      orders: ordersRes.rows,
    });
  } catch (err) {
    console.error('Store state error:', err);
    res.status(500).json({ error: 'Failed to load store state' });
  }
});

// 7. Сброс счётчика промокода из админки (для удобного тестирования в UI)
app.post('/api/admin/reset-promo', async (req, res) => {
  const parsed = promoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await pool.query(`UPDATE promocodes SET used_count = 0 WHERE code = $1`, [parsed.data.code]);
  res.json({ success: true });
});

// Имитация платежного шлюза для кнопки "Оплатить" на фронтенде
app.post('/api/mock-gateway/pay', async (req, res) => {
  const { order_id } = req.body;
  const raw = JSON.stringify({
    event_id: `evt_ui_${crypto.randomUUID()}`,
    order_id,
    status: 'paid',
  });
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');

  const response = await fetch(`http://localhost:${PORT}/webhook/payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': signature },
    body: raw,
  });
  const data = await response.json();
  res.status(response.status).json(data);
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

async function shutdown() {
  console.log('Shutting down gracefully...');
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

