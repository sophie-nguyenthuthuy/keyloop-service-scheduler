import { buildApp } from '../src/app.js';

const startsAtDate = new Date(Date.now() + 24 * 60 * 60 * 1_000);
startsAtDate.setUTCMinutes(0, 0, 0);
const startsAt = startsAtDate.toISOString();
let appointmentSequence = 0;

const app = await buildApp({
  databasePath: ':memory:',
  logger: false,
  idGenerator: () => `appointment-demo-${++appointmentSequence}`,
});

function printStep(label: string, statusCode: number, body: string): void {
  console.log(`\n${label} (${statusCode})`);
  console.log(JSON.stringify(JSON.parse(body) as unknown, null, 2));
}

try {
  const availability = await app.inject({
    method: 'GET',
    url: '/api/v1/dealerships/dealer-1/availability',
    query: { serviceTypeId: 'service-oil', startsAt },
  });
  printStep('1. Advisory availability check', availability.statusCode, availability.body);

  const bookingPayload = {
    dealershipId: 'dealer-1',
    customerId: 'customer-1',
    vehicleId: 'vehicle-1',
    serviceTypeId: 'service-oil',
    startsAt,
  };
  const confirmed = await app.inject({
    method: 'POST',
    url: '/api/v1/appointments',
    headers: { 'idempotency-key': 'demo-confirm-oil' },
    payload: bookingPayload,
  });
  printStep('2. Authoritative booking', confirmed.statusCode, confirmed.body);

  const appointment = JSON.parse(confirmed.body) as { id: string };
  const fetched = await app.inject({
    method: 'GET',
    url: `/api/v1/appointments/${appointment.id}`,
  });
  printStep('3. Persisted appointment', fetched.statusCode, fetched.body);

  const replayed = await app.inject({
    method: 'POST',
    url: '/api/v1/appointments',
    headers: { 'idempotency-key': 'demo-confirm-oil' },
    payload: bookingPayload,
  });
  printStep('4. Safe idempotent replay', replayed.statusCode, replayed.body);

  const overlapping = await app.inject({
    method: 'POST',
    url: '/api/v1/appointments',
    headers: { 'idempotency-key': 'demo-overlap' },
    payload: {
      ...bookingPayload,
      customerId: 'customer-2',
      vehicleId: 'vehicle-2',
    },
  });
  printStep('5. Overlapping booking rejected', overlapping.statusCode, overlapping.body);

  if (
    availability.statusCode !== 200 ||
    confirmed.statusCode !== 201 ||
    fetched.statusCode !== 200 ||
    replayed.statusCode !== 200 ||
    overlapping.statusCode !== 409
  ) {
    throw new Error('The demo did not produce the expected API outcomes.');
  }
} finally {
  await app.close();
}
