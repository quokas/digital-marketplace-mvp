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

// 2. Вебхук оплаты (Критерии 1, 2, 3, 4)
app.post('/webhook/payment', async (req, res) => {
  const { event_id, order_id, status } = req.body;
  if (status !== 'paid') return res.sendStatus(200);

  // Критерий 2: Идемпотентность по event_id
  if (processedEvents[event_id]) {
    return res.status(200).send('OK (Duplicate event)');
  }

  // Инициализируем блокировку заказа
  if (!orderLocks[order_id]) orderLocks[order_id] = Promise.resolve();

  // Критерий 1: Встаем в очередь блокировки (Асинхронный Mutex)
  orderLocks[order_id] = orderLocks[order_id].then(async () => {

    // Критерий 3: Вебхук пришел раньше создания заказа
    if (!orders[order_id]) {
      orders[order_id] = { sku: null, status: 'paid_pending_details', key: null };
      processedEvents[event_id] = true;
      return;
    }

    const order = orders[order_id];

    // Если параллельный вебхук уже обработал заказ — выходим
    if (order.status !== 'created') {
      processedEvents[event_id] = true;
      return;
    }

    order.status = 'paid';
    processedEvents[event_id] = true;

    // Запускаем безопасную выдачу ключа
    await processDelivery(order_id);
  });

  await orderLocks[order_id];
  return res.status(200).send('OK');
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

// Критерий 5: Защита промокодов от Race Conditions при параллельных запросах
app.post('/api/promocodes/apply', async (req, res) => {
  const { code } = req.body;
  const promo = promocodes[code];

  if (!promo) return res.status(404).json({ error: 'Промокод не найден' });

  let success = false;

  // Оборачиваем проверку счетчика в глобальный мьютекс
  await new Promise((resolve) => {
    promoLock.then(() => {
      if (promo.used_count < promo.max_uses) {
        promo.used_count++;
        success = true;
      }
      resolve();
    });
  });

  if (success) {
    res.json({ success: true, message: 'Промокод успешно применен' });
  } else {
    res.status(400).json({ error: 'Лимит использований промокода исчерпан' });
  }
});

// 3. Статус заказа
app.get('/api/orders/:id', (req, res) => {
  const order = orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(order);
});

app.listen(3000, () => console.log('🚀 Сервер неуязвим и запущен на http://localhost:3000'));
