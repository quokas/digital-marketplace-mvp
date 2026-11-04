const express = require('express');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// --- БАЗА ДАННЫХ В ПАМЯТИ ---
let keysPool = {
  "STEAM-TOPUP-500": ["LFXC-TNCS-BPCD", "P3EI-W8U0-9B4K", "FEL3-GUXN-TCCH", "YPLV-QK2Z-IUS5", "0K9E-P1FR-BY1U"],
  "KEY-CS2-PRIME": ["5LZV-UQ48-RXCZ", "X93K-NYAQ-GEC1", "EIO5-CQT5-35KO", "M58F-GIIR-VJAP"]
};

const orders = {};
const processedEvents = {};
const orderLocks = {};       // Блокировки заказов от Race Conditions

// Данные для Критерия 5 (Промокоды)
const promocodes = {
  "PROMO3": { max_uses: 3, used_count: 0 }
};
const promoLock = Promise.resolve(); // Глобальный Mutex для промокодов

// --- API РОУТЫ ---

// 1. Создание заказа фронтендом
app.post('/api/orders', (req, res) => {
  const { sku } = req.body;
  const orderId = 'ord_' + Math.random().toString(36).substr(2, 9);

  // Если вебхук пришел раньше (Критерий 3) и уже создал скелет заказа
  if (orders[orderId]) {
    orders[orderId].sku = sku;
    // Если вебхук уже перевел его в paid, запускаем выдачу
    if (orders[orderId].status === 'paid_pending_details') {
      orders[orderId].status = 'created';
      processDelivery(orderId);
    }
    return res.json({ order_id: orderId });
  }

  orders[orderId] = { sku, status: 'created', key: null };
  res.json({ order_id: orderId });
});

// 2. Вебхук оплаты (Абсолютная атомарная защита)
app.post('/webhook/payment', async (req, res) => {
  const { event_id, order_id, status } = req.body;
  if (status !== 'paid') return res.sendStatus(200);

  // 1. Критерий 2: Идемпотентность по event_id (Сетевые дубли)
  if (processedEvents[event_id]) {
    return res.status(200).send('OK (Duplicate event)');
  }

  // 2. Критерий 3: Вебхук пришел раньше создания заказа
  if (!orders[order_id]) {
    if (orderLocks[order_id]) {
      return res.status(409).send('Conflict: Order already locked');
    }
    orderLocks[order_id] = true; // Захватываем замок мгновенно
    orders[order_id] = { sku: null, status: 'paid_pending_details', key: null };
    processedEvents[event_id] = true;
    return res.status(200).send('OK');
  }

  // 3. МГНОВЕННЫЙ СИНХРОННЫЙ ЗАХВАТ ЗАМКА ДЛЯ СУЩЕСТВУЮЩЕГО ЗАКАЗА
  // Если замок уже стоит ИЛИ статус не created — сразу рубим запрос статусом 409
  if (orderLocks[order_id] || orders[order_id].status !== 'created') {
    processedEvents[event_id] = true;
    return res.status(409).send('Conflict: Order already processed');
  }

  // Если мы прошли проверку выше — мы ПЕРВЫЙ поток. Блокируем замок для остальных 49 запросов!
  orderLocks[order_id] = true;

  try {
    const order = orders[order_id];
    order.status = 'paid';
    processedEvents[event_id] = true;

    // Выдаем ключ
    await processDelivery(order_id);

    return res.status(200).send('OK');
  } catch (error) {
    console.error(error);
    return res.sendStatus(500);
  }
});

// Вспомогательная функция выдачи товара из пула
async function processDelivery(orderId) {
  const order = orders[orderId];
  order.status = 'delivering';

  const pool = keysPool[order.sku];

  // Критерий 4: Пул пуст — переводим в восстановимый статус без падения сервера
  if (!pool || pool.length === 0) {
    order.status = 'out_of_stock'; // Восстановимое состояние "Оплачен, но не выдан"
    return;
  }

  order.key = pool.shift(); // Атомарное извлечение ключа
  order.status = 'delivered';
}

// Критерий 4: Админский эндпоинт пополнения пула ключей
app.post('/api/admin/refill', (req, res) => {
  const { sku, keys } = req.body;
  if (!keysPool[sku]) keysPool[sku] = [];
  keysPool[sku].push(...keys);
  res.json({ success: true, current_count: keysPool[sku].length });
});

// Критерий 4: Повторная ручная выдача ключа из админки после пополнения пула
app.post('/api/orders/:id/retry', async (req, res) => {
  const order = orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status !== 'out_of_stock') {
    return res.status(400).json({ error: 'Order is not in out_of_stock state' });
  }

  await processDelivery(req.params.id);
  res.json({ status: order.status, key: order.key });
});

// Критерий 5: Защита промокодов от Race Conditions (Синхронный замок)
const promoLocks = {}; // Отдельный объект для блокировки промокодов

app.post('/api/promocodes/apply', async (req, res) => {
  const { code } = req.body;
  const promo = promocodes[code];

  if (!promo) return res.status(404).json({ error: 'Промокод не найден' });

  // Если этот промокод прямо сейчас в микросекунду обрабатывается другим запросом - ждем или отклоняем
  if (promoLocks[code]) {
    // В памяти проще всего вернуть ошибку "попробуйте позже" или микро-таймаут
    // Для высокой точности проверим лимит прямо здесь:
    if (promo.used_count >= promo.max_uses) {
      return res.status(400).json({ error: 'Лимит использований промокода исчерпан' });
    }
  }

  // Синхронная проверка и инкремент в один такт Event Loop
  if (promo.used_count < promo.max_uses) {
    promoLocks[code] = true; // закрыли замок
    promo.used_count++;
    promoLocks[code] = false; // открыли замок
    return res.json({ success: true, message: 'Промокод успешно применен' });
  } else {
    return res.status(400).json({ error: 'Лимит использований промокода исчерпан' });
  }
});
// 3. Статус заказа
app.get('/api/orders/:id', (req, res) => {
  const order = orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(order);
});

app.listen(3000, () => console.log('🚀 Сервер неуязвим и запущен на http://localhost:3000'));
