import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';

const NOW = new Date('2026-10-08T06:00:00.000Z');
const apps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];

interface AppointmentResponse {
  id: string;
  status: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  dealership: { id: string };
  customer: { id: string };
  vehicle: { id: string };
  serviceType: { id: string; durationMinutes: number };
  technician: { id: string };
  serviceBay: { id: string };
}

interface ProblemResponse {
  status: number;
  code: string;
  requestId: string;
}

function bookingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dealershipId: 'dealer-1',
    customerId: 'customer-1',
    vehicleId: 'vehicle-1',
    serviceTypeId: 'service-oil',
    startsAt: '2030-01-15T09:00:00Z',
    ...overrides,
  };
}

async function createTestApp(options: { persisted?: boolean } = {}): Promise<FastifyInstance> {
  let sequence = 0;
  let databasePath = ':memory:';
  if (options.persisted === true) {
    const directory = mkdtempSync(join(tmpdir(), 'keyloop-api-test-'));
    temporaryDirectories.push(directory);
    databasePath = join(directory, 'scheduler.sqlite');
  }

  const app = await buildApp({
    databasePath,
    logger: false,
    clock: () => new Date(NOW),
    idGenerator: () => `appointment-api-${++sequence}`,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

void describe('HTTP API', () => {
  void test('creates and retrieves the fully associated persisted appointment', async () => {
    const app = await createTestApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: {
        'idempotency-key': 'api-create-001',
        'x-request-id': 'request-api-create-001',
      },
      payload: bookingPayload(),
    });

    assert.equal(created.statusCode, 201);
    assert.match(created.headers['content-type'] ?? '', /^application\/json/);
    assert.equal(created.headers['x-request-id'], 'request-api-create-001');
    assert.equal(created.headers['idempotency-replayed'], 'false');
    assert.equal(created.headers.location, '/api/v1/appointments/appointment-api-1');

    const appointment = created.json<AppointmentResponse>();
    assert.deepEqual(
      {
        id: appointment.id,
        status: appointment.status,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        createdAt: appointment.createdAt,
        dealershipId: appointment.dealership.id,
        customerId: appointment.customer.id,
        vehicleId: appointment.vehicle.id,
        serviceType: appointment.serviceType,
        technicianId: appointment.technician.id,
        bayId: appointment.serviceBay.id,
      },
      {
        id: 'appointment-api-1',
        status: 'confirmed',
        startsAt: '2030-01-15T09:00:00.000Z',
        endsAt: '2030-01-15T10:00:00.000Z',
        createdAt: NOW.toISOString(),
        dealershipId: 'dealer-1',
        customerId: 'customer-1',
        vehicleId: 'vehicle-1',
        serviceType: {
          id: 'service-oil',
          name: 'Oil and Filter Service',
          durationMinutes: 60,
        },
        technicianId: 'tech-1',
        bayId: 'bay-1',
      },
    );

    const fetched = await app.inject({
      method: 'GET',
      url: created.headers.location,
    });
    assert.equal(fetched.statusCode, 200);
    assert.deepEqual(fetched.json(), appointment);
  });

  void test('exposes advisory availability without reserving resources', async () => {
    const app = await createTestApp();
    const query = {
      serviceTypeId: 'service-diagnostic',
      startsAt: '2030-01-15T09:00:00+01:00',
    };

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/dealerships/dealer-1/availability',
      query,
    });
    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/dealerships/dealer-1/availability',
      query,
    });

    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), {
      dealershipId: 'dealer-1',
      serviceTypeId: 'service-diagnostic',
      startsAt: '2030-01-15T08:00:00.000Z',
      endsAt: '2030-01-15T09:30:00.000Z',
      durationMinutes: 90,
      available: true,
      availableTechnicianCount: 1,
      availableBayCount: 1,
    });
    assert.deepEqual(second.json(), first.json());
  });

  void test('maps business errors to stable problem details', async () => {
    const app = await createTestApp();
    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: { 'x-request-id': 'request-owner-mismatch' },
      payload: bookingPayload({ vehicleId: 'vehicle-2' }),
    });

    assert.equal(mismatch.statusCode, 422);
    assert.match(mismatch.headers['content-type'] ?? '', /^application\/problem\+json/);
    assert.deepEqual(mismatch.json<ProblemResponse>(), {
      type: 'urn:keyloop:problem:vehicle-owner-mismatch',
      title: 'Business rule violation',
      status: 422,
      detail: "Vehicle 'vehicle-2' is not owned by customer 'customer-1'.",
      instance: '/api/v1/appointments',
      code: 'VEHICLE_OWNER_MISMATCH',
      requestId: 'request-owner-mismatch',
    });

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/appointments/appointment-missing',
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json<ProblemResponse>().code, 'APPOINTMENT_NOT_FOUND');
  });

  void test('returns the original appointment for an idempotent replay and rejects changed payload', async () => {
    const app = await createTestApp();
    const headers = { 'idempotency-key': 'api-idempotency-001' };
    const payload = bookingPayload();

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers,
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers,
      payload: bookingPayload({ startsAt: '2030-01-15T10:00:00+01:00' }),
    });
    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers,
      payload: bookingPayload({ startsAt: '2030-01-15T10:00:00Z' }),
    });

    assert.equal(first.statusCode, 201);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.deepEqual(replay.json(), first.json());
    assert.equal(changed.statusCode, 409);
    assert.equal(changed.json<ProblemResponse>().code, 'IDEMPOTENCY_KEY_REUSED');
  });

  void test('rejects malformed, offsetless, and schema-invalid appointment requests', async () => {
    const app = await createTestApp();

    for (const startsAt of ['not-a-date', '2030-01-15T09:00:00', '2030-02-30T09:00:00Z']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/appointments',
        payload: bookingPayload({ startsAt }),
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json<ProblemResponse>().code, 'INVALID_TIMESTAMP');
    }

    const schemaInvalid = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      payload: bookingPayload({ dealershipId: '' }),
    });
    assert.equal(schemaInvalid.statusCode, 400);
    assert.equal(schemaInvalid.json<ProblemResponse>().code, 'VALIDATION_ERROR');
  });

  void test('accepts an offset-aware past timestamp because the MVP has no future-only policy', async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      payload: bookingPayload({ startsAt: '2026-10-08T05:59:59Z' }),
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json<AppointmentResponse>().startsAt, '2026-10-08T05:59:59.000Z');
  });

  void test('limits concurrent booking requests to the available capacity', async () => {
    const app = await createTestApp({ persisted: true });
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/appointments',
        headers: { 'idempotency-key': 'concurrent-request-1' },
        payload: bookingPayload(),
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/appointments',
        headers: { 'idempotency-key': 'concurrent-request-2' },
        payload: bookingPayload({ customerId: 'customer-2', vehicleId: 'vehicle-2' }),
      }),
    ]);

    assert.deepEqual(
      [first.statusCode, second.statusCode].sort((left, right) => left - right),
      [201, 409],
    );
    const conflict = first.statusCode === 409 ? first : second;
    assert.equal(conflict.json<ProblemResponse>().code, 'NO_AVAILABILITY');
  });

  void test('publishes health, metrics, and an OpenAPI contract for all public routes', async () => {
    const app = await createTestApp();

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), { status: 'ok' });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { status: 'ready' });

    await app.inject({
      method: 'GET',
      url: '/api/v1/dealerships/dealer-1/availability',
      query: { serviceTypeId: 'service-oil', startsAt: '2030-01-15T09:00:00Z' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      payload: bookingPayload(),
    });

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(metrics.statusCode, 200);
    assert.match(metrics.headers['content-type'] ?? '', /^text\/plain/);
    assert.match(metrics.body, /keyloop_availability_checks_total\{available="true"\} 1/);
    assert.match(metrics.body, /keyloop_booking_attempts_total\{outcome="confirmed"\} 1/);
    assert.match(
      metrics.body,
      /keyloop_http_request_duration_seconds_count\{method="GET",route="\/health\/live",status_code="200"\} 1/,
    );

    const specification = await app.inject({ method: 'GET', url: '/openapi.json' });
    assert.equal(specification.statusCode, 200);
    const document = specification.json<{
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    }>();
    assert.match(document.openapi, /^3\./);
    assert.ok(document.paths['/health/live']?.get);
    assert.ok(document.paths['/health/ready']?.get);
    assert.ok(document.paths['/api/v1/dealerships/{id}/availability']?.get);
    assert.ok(document.paths['/api/v1/appointments']?.post);
    assert.ok(document.paths['/api/v1/appointments/{id}']?.get);
  });
});
