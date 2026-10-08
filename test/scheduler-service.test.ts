import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { SchedulerService } from '../src/application/scheduler-service.js';
import { ApplicationError } from '../src/domain/errors.js';
import type { BookingCommand } from '../src/domain/models.js';
import { SqliteSchedulerRepository } from '../src/infrastructure/sqlite-scheduler-repository.js';

const NOW = new Date('2026-10-08T06:00:00.000Z');
const temporaryDirectories: string[] = [];

function temporaryDatabase(): { databasePath: string; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'keyloop-scheduler-test-'));
  temporaryDirectories.push(directory);
  return { databasePath: join(directory, 'scheduler.sqlite'), directory };
}

function createFixture(databasePath = ':memory:') {
  const repository = new SqliteSchedulerRepository(databasePath);
  let sequence = 0;
  const service = new SchedulerService({
    repository,
    clock: () => new Date(NOW),
    idGenerator: () => `appointment-${++sequence}`,
  });
  return { repository, service };
}

function oilBooking(overrides: Partial<BookingCommand> = {}): BookingCommand {
  return {
    dealershipId: 'dealer-1',
    customerId: 'customer-1',
    vehicleId: 'vehicle-1',
    serviceTypeId: 'service-oil',
    startsAt: '2030-01-15T09:00:00Z',
    ...overrides,
  };
}

function expectApplicationError(
  operation: () => unknown,
  expected: { status: number; code: string },
): ApplicationError {
  let thrown: unknown;
  try {
    operation();
  } catch (error: unknown) {
    thrown = error;
  }

  assert.ok(thrown instanceof ApplicationError, 'expected an ApplicationError');
  assert.equal(thrown.status, expected.status);
  assert.equal(thrown.code, expected.code);
  return thrown;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

void describe('SchedulerService and SQLite allocation', () => {
  void test('persists a confirmed appointment with all associations and computed duration', () => {
    const { repository, service } = createFixture();

    try {
      const result = service.createAppointment(oilBooking());

      assert.equal(result.replayed, false);
      assert.deepEqual(result.appointment, {
        id: 'appointment-1',
        status: 'confirmed',
        startsAt: '2030-01-15T09:00:00.000Z',
        endsAt: '2030-01-15T10:00:00.000Z',
        createdAt: NOW.toISOString(),
        cancelledAt: null,
        dealership: {
          id: 'dealer-1',
          name: 'Keyloop Central',
          timezone: 'Europe/London',
        },
        customer: {
          id: 'customer-1',
          name: 'Sophie Carter',
          email: 'sophie.carter@example.test',
        },
        vehicle: {
          id: 'vehicle-1',
          vin: 'WVWZZZ1JZXW000001',
          make: 'Volkswagen',
          model: 'Golf',
        },
        serviceType: {
          id: 'service-oil',
          name: 'Oil and Filter Service',
          durationMinutes: 60,
        },
        technician: { id: 'tech-1', name: 'Alex Morgan' },
        serviceBay: { id: 'bay-1', name: 'Service Bay 1' },
      });
      assert.deepEqual(service.getAppointment(result.appointment.id), result.appointment);
    } finally {
      repository.close();
    }
  });

  void test('selects only a qualified technician and active bay for a 90-minute diagnostic', () => {
    const { repository, service } = createFixture();

    try {
      const result = service.createAppointment(oilBooking({ serviceTypeId: 'service-diagnostic' }));

      assert.equal(result.appointment.technician.id, 'tech-2');
      assert.equal(result.appointment.serviceBay.id, 'bay-1');
      assert.equal(result.appointment.serviceType.durationMinutes, 90);
      assert.equal(result.appointment.endsAt, '2030-01-15T10:30:00.000Z');
    } finally {
      repository.close();
    }
  });

  void test('rejects overlapping capacity but permits a half-open adjacent interval', () => {
    const { repository, service } = createFixture();

    try {
      service.createAppointment(oilBooking());

      expectApplicationError(
        () =>
          service.createAppointment(
            oilBooking({
              customerId: 'customer-2',
              vehicleId: 'vehicle-2',
              serviceTypeId: 'service-diagnostic',
              startsAt: '2030-01-15T09:30:00Z',
            }),
          ),
        { status: 409, code: 'NO_AVAILABILITY' },
      );

      const adjacent = service.createAppointment(
        oilBooking({
          customerId: 'customer-2',
          vehicleId: 'vehicle-2',
          serviceTypeId: 'service-diagnostic',
          startsAt: '2030-01-15T10:00:00Z',
        }),
      );
      assert.equal(adjacent.appointment.startsAt, '2030-01-15T10:00:00.000Z');
      assert.equal(adjacent.appointment.endsAt, '2030-01-15T11:30:00.000Z');
    } finally {
      repository.close();
    }
  });

  void test('availability is advisory and reflects technician and bay capacity', () => {
    const { repository, service } = createFixture();

    try {
      const query = {
        dealershipId: 'dealer-1',
        serviceTypeId: 'service-oil',
        startsAt: '2030-01-15T09:00:00Z',
      };
      assert.deepEqual(service.getAvailability(query), {
        dealershipId: 'dealer-1',
        serviceTypeId: 'service-oil',
        startsAt: '2030-01-15T09:00:00.000Z',
        endsAt: '2030-01-15T10:00:00.000Z',
        durationMinutes: 60,
        available: true,
        availableTechnicianCount: 1,
        availableBayCount: 1,
      });

      service.createAppointment(oilBooking());

      assert.deepEqual(service.getAvailability(query), {
        dealershipId: 'dealer-1',
        serviceTypeId: 'service-oil',
        startsAt: '2030-01-15T09:00:00.000Z',
        endsAt: '2030-01-15T10:00:00.000Z',
        durationMinutes: 60,
        available: false,
        availableTechnicianCount: 0,
        availableBayCount: 0,
      });
      assert.equal(
        service.getAvailability({ ...query, startsAt: '2030-01-15T10:00:00Z' }).available,
        true,
      );
    } finally {
      repository.close();
    }
  });

  void test('returns specific errors for unknown references and vehicle ownership mismatch', () => {
    const { repository, service } = createFixture();

    try {
      const cases: Array<{
        command: BookingCommand;
        expected: { status: number; code: string };
      }> = [
        {
          command: oilBooking({ dealershipId: 'dealer-missing' }),
          expected: { status: 404, code: 'DEALERSHIP_NOT_FOUND' },
        },
        {
          command: oilBooking({ customerId: 'customer-missing' }),
          expected: { status: 404, code: 'CUSTOMER_NOT_FOUND' },
        },
        {
          command: oilBooking({ vehicleId: 'vehicle-missing' }),
          expected: { status: 404, code: 'VEHICLE_NOT_FOUND' },
        },
        {
          command: oilBooking({ serviceTypeId: 'service-missing' }),
          expected: { status: 404, code: 'SERVICE_TYPE_NOT_FOUND' },
        },
        {
          command: oilBooking({ vehicleId: 'vehicle-2' }),
          expected: { status: 422, code: 'VEHICLE_OWNER_MISMATCH' },
        },
      ];

      for (const scenario of cases) {
        expectApplicationError(
          () => service.createAppointment(scenario.command),
          scenario.expected,
        );
      }
    } finally {
      repository.close();
    }
  });

  void test('replays the same idempotent request and rejects key reuse with another payload', () => {
    const { repository, service } = createFixture();

    try {
      const command = oilBooking({ idempotencyKey: 'booking-2030-01-15-001' });
      const first = service.createAppointment(command);
      const replay = service.createAppointment({
        ...command,
        // A semantically identical instant must fingerprint the same after normalization.
        startsAt: '2030-01-15T10:00:00+01:00',
      });

      assert.equal(first.replayed, false);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.appointment, first.appointment);

      expectApplicationError(
        () => service.createAppointment({ ...command, startsAt: '2030-01-15T10:00:00Z' }),
        { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' },
      );
    } finally {
      repository.close();
    }
  });

  void test('rejects malformed and offsetless timestamps', () => {
    const { repository, service } = createFixture();

    try {
      for (const startsAt of ['not-a-date', '2030-01-15T09:00:00', '2030-02-30T09:00:00Z']) {
        expectApplicationError(() => service.createAppointment(oilBooking({ startsAt })), {
          status: 400,
          code: 'INVALID_TIMESTAMP',
        });
      }
    } finally {
      repository.close();
    }
  });

  void test('persists appointments across a database close and reopen', () => {
    const { databasePath } = temporaryDatabase();
    const first = createFixture(databasePath);
    const booked = first.service.createAppointment(oilBooking());
    first.repository.close();

    const reopened = createFixture(databasePath);
    try {
      assert.deepEqual(reopened.service.getAppointment(booked.appointment.id), booked.appointment);
      assert.equal(reopened.service.isReady(), true);
    } finally {
      reopened.repository.close();
    }
  });

  void test('serializes competing allocations so capacity is never oversold', async () => {
    const { databasePath } = temporaryDatabase();
    const first = createFixture(databasePath);
    const second = createFixture(databasePath);

    try {
      const requests = [
        Promise.resolve().then(() => first.service.createAppointment(oilBooking())),
        Promise.resolve().then(() =>
          second.service.createAppointment(
            oilBooking({
              customerId: 'customer-2',
              vehicleId: 'vehicle-2',
            }),
          ),
        ),
      ];
      const results = await Promise.allSettled(requests);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      const rejection = rejected[0];
      assert.ok(rejection);
      assert.ok(rejection.reason instanceof ApplicationError);
      assert.equal(rejection.reason.code, 'NO_AVAILABILITY');
    } finally {
      first.repository.close();
      second.repository.close();
    }
  });
});
