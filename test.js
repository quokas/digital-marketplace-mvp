require('dotenv').config();
const crypto = require('crypto');

const BASE_URL = `http://localhost:${process.env.PORT || 3000}`;
const SECRET = process.env.WEBHOOK_SECRET;
const TOTAL = 50;

function sign(rawBody) {
  return crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
}

async function sendWebhook(payload) {
  const raw = JSON.stringify(payload);
  return fetch(`${BASE_URL}/webhook/payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': sign(raw) },
    body: raw,
  });
}

async function createOrder(sku = 'STEAM-TOPUP-500') {
  const res = await fetch(`${BASE_URL}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku }),
  });
  return (await res.json()).id;
}

async function run() {
  console.log('1. Пополняем пул ключей...');
  const keys = Array.from({ length: 100 }, () => `KEY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
  await fetch(`${BASE_URL}/api/admin/refill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'STEAM-TOPUP-500', keys }),
  });

  console.log('\nТест 1: Идемпотентность (50 дублей одного вебхука)...');
  const order1 = await createOrder();
  const sameEvent = `evt_${crypto.randomUUID()}`;
  const res1 = await Promise.all(
    Array.from({ length: TOTAL }, () => sendWebhook({ event_id: sameEvent, order_id: order1, status: 'paid' }))
  );
  const ok1 = res1.filter((r) => r.status === 200).length;
  const check1 = await (await fetch(`${BASE_URL}/api/orders/${order1}`)).json();
  console.log(`-> 200 OK: ${ok1}/${TOTAL}, статус заказа: ${check1.status}, ключ: ${check1.key}`);

  console.log('\nТест 2: Фрод-атака (50 разных платежей на 1 заказ)...');
  const order2 = await createOrder();
  const res2 = await Promise.all(
    Array.from({ length: TOTAL }, () => sendWebhook({ event_id: `evt_${crypto.randomUUID()}`, order_id: order2, status: 'paid' }))
  );
  const ok2 = res2.filter((r) => r.status === 200).length;
  const conflict2 = res2.filter((r) => r.status === 409).length;
  console.log(`-> Прошёл: ${ok2}, заблокировано (409 Conflict): ${conflict2}`);

  console.log('\nТест 3: Гонка промокодов (50 запросов на PROMO3 с лимитом 3)...');
  const res3 = await Promise.all(
    Array.from({ length: TOTAL }, () =>
      fetch(`${BASE_URL}/api/promocodes/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'PROMO3' }),
      })
    )
  );
  const ok3 = res3.filter((r) => r.status === 200).length;
  const fail3 = res3.filter((r) => r.status === 400).length;
  console.log(`-> Применено: ${ok3} из 3, отклонено: ${fail3}`);
}

run().catch(console.error);
