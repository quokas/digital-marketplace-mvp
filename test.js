const total = 50;

// Функция для авто-пополнения базы ключами перед тестом
async function refillKeys() {
  const fakeKeys = Array.from({ length: 100 }, (_, i) => `FAKE-KEY-${Math.random().toString(36).substr(2, 5).toUpperCase()}`);
  await fetch('http://localhost:3000/api/admin/refill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'STEAM-TOPUP-500', keys: fakeKeys })
  });
}

async function createOrder() {
  const orderRes = await fetch('http://localhost:3000/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'STEAM-TOPUP-500' })
  });
  if (!orderRes.ok) throw new Error('Не удалось создать заказ.');
  const { order_id } = await orderRes.json();
  return order_id;
}

async function runRaceTest() {
  console.log('--- ЗАПУСК СТРЕСС-ТЕСТОВ (ОЧИСТКА И ЗАПУСК) ---');

  // Пополняем пул ключей, чтобы не было статуса out_of_stock
  await refillKeys();

  // =========================================================================
  // ТЕСТ 1: Проверка идемпотентности платежной системы (Одинаковый event_id)
  // =========================================================================
  console.log('\nТест 1: Симуляция сетевого сбоя эквайринга (50 одинаковых вебхуков)...');
  const orderId1 = await createOrder();
  const sameEventId = `evt_payment_fallback_${Date.now()}`;

  const promises1 = Array.from({ length: total }, () =>
    fetch('http://localhost:3000/webhook/payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: sameEventId,
        order_id: orderId1,
        status: 'paid',
        amount: 500,
        currency: 'RUB'
      })
    }).then(res => res.status)
  );

  const statuses1 = await Promise.all(promises1);
  const okResponses1 = statuses1.filter(s => s === 200).length;

  const statusRes1 = await fetch(`http://localhost:3000/api/orders/${orderId1}`);
  const finalOrder1 = await statusRes1.json();

  console.log(`-> Успешных ответов (200 OK): ${okResponses1} из ${total}`);
  console.log(`-> Статус заказа в БД: ${finalOrder1.status}`);

  if (okResponses1 === total && finalOrder1.status === 'delivered' && finalOrder1.key) {
    console.log('✅ ТЕСТ 1 ПРОЙДЕН: Идемпотентность работает, выдан 1 ключ!');
  } else {
    console.error('❌ ТЕСТ 1 ПРОВАЛЕН: Нарушена логика идемпотентности эквайринга.');
  }

  // =========================================================================
  // ТЕСТ 2: Проверка защиты от фрода / конкурентных оплат (Разные event_id)
  // =========================================================================
  console.log('\nТест 2: Симуляция конкурентной атаки (50 разных платежей на 1 заказ)...');
  const orderId2 = await createOrder();

  const promises2 = Array.from({ length: total }, (_, i) =>
    fetch('http://localhost:3000/webhook/payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: `evt_fraud_attack_${i}_${Date.now()}`,
        order_id: orderId2,
        status: 'paid',
        amount: 500,
        currency: 'RUB'
      })
    }).then(res => res.status)
  );

  const statuses2 = await Promise.all(promises2);
  const okResponses2 = statuses2.filter(s => s === 200).length;

  const statusRes2 = await fetch(`http://localhost:3000/api/orders/${orderId2}`);
  const finalOrder2 = await statusRes2.json();

  console.log(`-> Успешно обработано оплат (200 OK): ${okResponses2} из ${total}`);
  console.log(`-> Остальные запросы отклонены (ошибки блокировки): ${total - okResponses2}`);

  if (okResponses2 === 1 && finalOrder2.status === 'delivered') {
    console.log('✅ ТЕСТ 2 ПРОЙДЕН: Mutex заблокировал повторные разные оплаты!');
  } else {
    console.error('❌ ТЕСТ 2 ПРОВАЛЕН: Заказ пропустил дублирующие оплаты с разными event_id.');
  }
}

runRaceTest().catch(console.error);
