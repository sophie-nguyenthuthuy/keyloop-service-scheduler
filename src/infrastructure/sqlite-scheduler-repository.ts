import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  ApplicationError,
  badRequest,
  conflict,
  notFound,
  unprocessable,
} from '../domain/errors.js';
import type {
  AllocationRequest,
  AllocationResult,
  Appointment,
  Availability,
  AvailabilityRequest,
  SchedulerRepository,
} from '../domain/models.js';
import { toIsoString } from '../domain/time.js';

interface ServiceTypeRow {
  id: string;
  dealership_id: string;
  name: string;
  duration_minutes: number;
  active: number;
}

interface IdRow {
  id: string;
}

interface CountRow {
  count: number;
}

interface IdempotencyRow {
  id: string;
  request_fingerprint: string;
}

interface AppointmentRow {
  id: string;
  status: string;
  starts_at_ms: number;
  ends_at_ms: number;
  created_at_ms: number;
  cancelled_at_ms: number | null;
  dealership_id: string;
  dealership_name: string;
  dealership_timezone: string;
  customer_id: string;
  customer_name: string;
  customer_email: string;
  vehicle_id: string;
  vehicle_vin: string;
  vehicle_make: string;
  vehicle_model: string;
  service_type_id: string;
  service_type_name: string;
  duration_minutes: number;
  technician_id: string;
  technician_name: string;
  service_bay_id: string;
  service_bay_name: string;
}

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS dealerships (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS vehicles (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    vin TEXT NOT NULL UNIQUE,
    make TEXT NOT NULL,
    model TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS service_types (
    id TEXT PRIMARY KEY,
    dealership_id TEXT NOT NULL REFERENCES dealerships(id),
    name TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS service_type_skills (
    service_type_id TEXT NOT NULL REFERENCES service_types(id),
    skill_id TEXT NOT NULL REFERENCES skills(id),
    PRIMARY KEY (service_type_id, skill_id)
  );

  CREATE TABLE IF NOT EXISTS technicians (
    id TEXT PRIMARY KEY,
    dealership_id TEXT NOT NULL REFERENCES dealerships(id),
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS technician_skills (
    technician_id TEXT NOT NULL REFERENCES technicians(id),
    skill_id TEXT NOT NULL REFERENCES skills(id),
    PRIMARY KEY (technician_id, skill_id)
  );

  CREATE TABLE IF NOT EXISTS service_bays (
    id TEXT PRIMARY KEY,
    dealership_id TEXT NOT NULL REFERENCES dealerships(id),
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    dealership_id TEXT NOT NULL REFERENCES dealerships(id),
    customer_id TEXT NOT NULL REFERENCES customers(id),
    vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
    service_type_id TEXT NOT NULL REFERENCES service_types(id),
    technician_id TEXT NOT NULL REFERENCES technicians(id),
    service_bay_id TEXT NOT NULL REFERENCES service_bays(id),
    starts_at_ms INTEGER NOT NULL,
    ends_at_ms INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
    idempotency_key TEXT,
    request_fingerprint TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    cancelled_at_ms INTEGER,
    CHECK (ends_at_ms > starts_at_ms),
    CHECK (
      (status = 'confirmed' AND cancelled_at_ms IS NULL) OR
      (status = 'cancelled' AND cancelled_at_ms IS NOT NULL)
    )
  );

  CREATE UNIQUE INDEX IF NOT EXISTS appointments_idempotency_key_unique
    ON appointments(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

  CREATE INDEX IF NOT EXISTS appointments_technician_schedule
    ON appointments(technician_id, starts_at_ms, ends_at_ms)
    WHERE status = 'confirmed';

  CREATE INDEX IF NOT EXISTS appointments_bay_schedule
    ON appointments(service_bay_id, starts_at_ms, ends_at_ms)
    WHERE status = 'confirmed';

  CREATE INDEX IF NOT EXISTS technicians_dealership_active
    ON technicians(dealership_id, active, id);

  CREATE INDEX IF NOT EXISTS service_bays_dealership_active
    ON service_bays(dealership_id, active, id);

  CREATE TRIGGER IF NOT EXISTS appointments_prevent_technician_overlap_insert
  BEFORE INSERT ON appointments
  WHEN NEW.status = 'confirmed' AND EXISTS (
    SELECT 1
    FROM appointments existing
    WHERE existing.technician_id = NEW.technician_id
      AND existing.status = 'confirmed'
      AND existing.starts_at_ms < NEW.ends_at_ms
      AND NEW.starts_at_ms < existing.ends_at_ms
  )
  BEGIN
    SELECT RAISE(ABORT, 'technician_overlap');
  END;

  CREATE TRIGGER IF NOT EXISTS appointments_prevent_bay_overlap_insert
  BEFORE INSERT ON appointments
  WHEN NEW.status = 'confirmed' AND EXISTS (
    SELECT 1
    FROM appointments existing
    WHERE existing.service_bay_id = NEW.service_bay_id
      AND existing.status = 'confirmed'
      AND existing.starts_at_ms < NEW.ends_at_ms
      AND NEW.starts_at_ms < existing.ends_at_ms
  )
  BEGIN
    SELECT RAISE(ABORT, 'service_bay_overlap');
  END;

  CREATE TRIGGER IF NOT EXISTS appointments_prevent_technician_overlap_update
  BEFORE UPDATE OF technician_id, starts_at_ms, ends_at_ms, status ON appointments
  WHEN NEW.status = 'confirmed' AND EXISTS (
    SELECT 1
    FROM appointments existing
    WHERE existing.id <> NEW.id
      AND existing.technician_id = NEW.technician_id
      AND existing.status = 'confirmed'
      AND existing.starts_at_ms < NEW.ends_at_ms
      AND NEW.starts_at_ms < existing.ends_at_ms
  )
  BEGIN
    SELECT RAISE(ABORT, 'technician_overlap');
  END;

  CREATE TRIGGER IF NOT EXISTS appointments_prevent_bay_overlap_update
  BEFORE UPDATE OF service_bay_id, starts_at_ms, ends_at_ms, status ON appointments
  WHEN NEW.status = 'confirmed' AND EXISTS (
    SELECT 1
    FROM appointments existing
    WHERE existing.id <> NEW.id
      AND existing.service_bay_id = NEW.service_bay_id
      AND existing.status = 'confirmed'
      AND existing.starts_at_ms < NEW.ends_at_ms
      AND NEW.starts_at_ms < existing.ends_at_ms
  )
  BEGIN
    SELECT RAISE(ABORT, 'service_bay_overlap');
  END;
`;

const APPOINTMENT_SELECT = `
  SELECT
    appointment.id,
    appointment.status,
    appointment.starts_at_ms,
    appointment.ends_at_ms,
    appointment.created_at_ms,
    appointment.cancelled_at_ms,
    dealership.id AS dealership_id,
    dealership.name AS dealership_name,
    dealership.timezone AS dealership_timezone,
    customer.id AS customer_id,
    customer.name AS customer_name,
    customer.email AS customer_email,
    vehicle.id AS vehicle_id,
    vehicle.vin AS vehicle_vin,
    vehicle.make AS vehicle_make,
    vehicle.model AS vehicle_model,
    service_type.id AS service_type_id,
    service_type.name AS service_type_name,
    service_type.duration_minutes,
    technician.id AS technician_id,
    technician.name AS technician_name,
    service_bay.id AS service_bay_id,
    service_bay.name AS service_bay_name
  FROM appointments appointment
  JOIN dealerships dealership ON dealership.id = appointment.dealership_id
  JOIN customers customer ON customer.id = appointment.customer_id
  JOIN vehicles vehicle ON vehicle.id = appointment.vehicle_id
  JOIN service_types service_type ON service_type.id = appointment.service_type_id
  JOIN technicians technician ON technician.id = appointment.technician_id
  JOIN service_bays service_bay ON service_bay.id = appointment.service_bay_id
`;

export class SqliteSchedulerRepository implements SchedulerRepository {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    }

    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (databasePath !== ':memory:') {
      this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    }
    this.#database.exec(SCHEMA);
    this.#seed();
  }

  getAvailability(request: AvailabilityRequest): Availability {
    this.#ensureDealership(request.dealershipId);
    const serviceType = this.#getServiceType(request.dealershipId, request.serviceTypeId);
    const endsAtMs = this.#endsAt(request.startsAtMs, serviceType.duration_minutes);
    const availableTechnicianCount = this.#availableTechnicianCount(
      request.dealershipId,
      request.serviceTypeId,
      request.startsAtMs,
      endsAtMs,
    );
    const availableBayCount = this.#availableBayCount(
      request.dealershipId,
      request.startsAtMs,
      endsAtMs,
    );

    return {
      dealershipId: request.dealershipId,
      serviceTypeId: request.serviceTypeId,
      startsAt: toIsoString(request.startsAtMs),
      endsAt: toIsoString(endsAtMs),
      durationMinutes: serviceType.duration_minutes,
      available: availableTechnicianCount > 0 && availableBayCount > 0,
      availableTechnicianCount,
      availableBayCount,
    };
  }

  allocateAppointment(request: AllocationRequest): AllocationResult {
    return this.#immediateTransaction(() => {
      if (request.idempotencyKey !== null) {
        const existing = this.#database
          .prepare(
            `SELECT id, request_fingerprint
             FROM appointments
             WHERE idempotency_key = ?`,
          )
          .get(request.idempotencyKey) as unknown as IdempotencyRow | undefined;

        if (existing !== undefined) {
          if (existing.request_fingerprint !== request.requestFingerprint) {
            throw conflict(
              'IDEMPOTENCY_KEY_REUSED',
              'This Idempotency-Key was already used for a different booking request.',
            );
          }
          return { appointment: this.#requireAppointment(existing.id), replayed: true };
        }
      }

      this.#ensureDealership(request.dealershipId);
      this.#ensureCustomer(request.customerId);
      this.#ensureVehicleOwnership(request.vehicleId, request.customerId);
      const serviceType = this.#getServiceType(request.dealershipId, request.serviceTypeId);
      const endsAtMs = this.#endsAt(request.startsAtMs, serviceType.duration_minutes);

      const technicianId = this.#findAvailableTechnician(
        request.dealershipId,
        request.serviceTypeId,
        request.startsAtMs,
        endsAtMs,
      );
      const serviceBayId = this.#findAvailableBay(
        request.dealershipId,
        request.startsAtMs,
        endsAtMs,
      );

      if (technicianId === null || serviceBayId === null) {
        throw conflict(
          'NO_AVAILABILITY',
          'No qualified technician and service bay are both available for the requested interval.',
        );
      }

      this.#database
        .prepare(
          `INSERT INTO appointments (
             id, dealership_id, customer_id, vehicle_id, service_type_id,
             technician_id, service_bay_id, starts_at_ms, ends_at_ms,
             status, idempotency_key, request_fingerprint, created_at_ms, cancelled_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, NULL)`,
        )
        .run(
          request.appointmentId,
          request.dealershipId,
          request.customerId,
          request.vehicleId,
          request.serviceTypeId,
          technicianId,
          serviceBayId,
          request.startsAtMs,
          endsAtMs,
          request.idempotencyKey,
          request.requestFingerprint,
          request.createdAtMs,
        );

      return {
        appointment: this.#requireAppointment(request.appointmentId),
        replayed: false,
      };
    });
  }

  getAppointment(id: string): Appointment | null {
    return this.#findAppointment(id);
  }

  isReady(): boolean {
    if (this.#closed) {
      return false;
    }
    try {
      const row = this.#database.prepare('SELECT 1 AS value').get() as unknown as
        { value: number } | undefined;
      return row?.value === 1;
    } catch {
      return false;
    }
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  #seed(): void {
    this.#immediateTransaction(() => {
      this.#database
        .prepare('INSERT OR IGNORE INTO dealerships (id, name, timezone) VALUES (?, ?, ?)')
        .run('dealer-1', 'Keyloop Central', 'Europe/London');

      const customer = this.#database.prepare(
        'INSERT OR IGNORE INTO customers (id, name, email) VALUES (?, ?, ?)',
      );
      customer.run('customer-1', 'Sophie Carter', 'sophie.carter@example.test');
      customer.run('customer-2', 'Jordan Lee', 'jordan.lee@example.test');

      const vehicle = this.#database.prepare(
        'INSERT OR IGNORE INTO vehicles (id, customer_id, vin, make, model) VALUES (?, ?, ?, ?, ?)',
      );
      vehicle.run('vehicle-1', 'customer-1', 'WVWZZZ1JZXW000001', 'Volkswagen', 'Golf');
      vehicle.run('vehicle-2', 'customer-2', 'WBA3A5C50DF000001', 'BMW', '3 Series');

      const serviceType = this.#database.prepare(
        `INSERT OR IGNORE INTO service_types
           (id, dealership_id, name, duration_minutes)
         VALUES (?, ?, ?, ?)`,
      );
      serviceType.run('service-oil', 'dealer-1', 'Oil and Filter Service', 60);
      serviceType.run('service-diagnostic', 'dealer-1', 'Vehicle Diagnostic', 90);

      const skill = this.#database.prepare('INSERT OR IGNORE INTO skills (id, name) VALUES (?, ?)');
      skill.run('skill-maintenance', 'Routine Maintenance');
      skill.run('skill-diagnostics', 'Vehicle Diagnostics');

      const serviceSkill = this.#database.prepare(
        'INSERT OR IGNORE INTO service_type_skills (service_type_id, skill_id) VALUES (?, ?)',
      );
      serviceSkill.run('service-oil', 'skill-maintenance');
      serviceSkill.run('service-diagnostic', 'skill-diagnostics');

      const technician = this.#database.prepare(
        `INSERT OR IGNORE INTO technicians
           (id, dealership_id, name, active)
         VALUES (?, ?, ?, ?)`,
      );
      technician.run('tech-1', 'dealer-1', 'Alex Morgan', 1);
      technician.run('tech-2', 'dealer-1', 'Priya Shah', 1);

      const technicianSkill = this.#database.prepare(
        'INSERT OR IGNORE INTO technician_skills (technician_id, skill_id) VALUES (?, ?)',
      );
      technicianSkill.run('tech-1', 'skill-maintenance');
      technicianSkill.run('tech-2', 'skill-diagnostics');

      const bay = this.#database.prepare(
        `INSERT OR IGNORE INTO service_bays
           (id, dealership_id, name, active)
         VALUES (?, ?, ?, ?)`,
      );
      bay.run('bay-1', 'dealer-1', 'Service Bay 1', 1);
      bay.run('bay-2', 'dealer-1', 'Reserve Bay', 0);
    });
  }

  #ensureDealership(id: string): void {
    const row = this.#database
      .prepare('SELECT id FROM dealerships WHERE id = ? AND active = 1')
      .get(id) as unknown as IdRow | undefined;
    if (row === undefined) {
      throw notFound('DEALERSHIP_NOT_FOUND', `Active dealership '${id}' does not exist.`);
    }
  }

  #ensureCustomer(id: string): void {
    const row = this.#database
      .prepare('SELECT id FROM customers WHERE id = ?')
      .get(id) as unknown as IdRow | undefined;
    if (row === undefined) {
      throw notFound('CUSTOMER_NOT_FOUND', `Customer '${id}' does not exist.`);
    }
  }

  #ensureVehicleOwnership(vehicleId: string, customerId: string): void {
    const row = this.#database
      .prepare('SELECT id, customer_id FROM vehicles WHERE id = ?')
      .get(vehicleId) as unknown as { id: string; customer_id: string } | undefined;
    if (row === undefined) {
      throw notFound('VEHICLE_NOT_FOUND', `Vehicle '${vehicleId}' does not exist.`);
    }
    if (row.customer_id !== customerId) {
      throw unprocessable(
        'VEHICLE_OWNER_MISMATCH',
        `Vehicle '${vehicleId}' is not owned by customer '${customerId}'.`,
      );
    }
  }

  #getServiceType(dealershipId: string, serviceTypeId: string): ServiceTypeRow {
    const row = this.#database
      .prepare(
        `SELECT id, dealership_id, name, duration_minutes, active
         FROM service_types
         WHERE id = ?`,
      )
      .get(serviceTypeId) as unknown as ServiceTypeRow | undefined;
    if (row === undefined || row.active !== 1) {
      throw notFound(
        'SERVICE_TYPE_NOT_FOUND',
        `Active service type '${serviceTypeId}' does not exist.`,
      );
    }
    if (row.dealership_id !== dealershipId) {
      throw unprocessable(
        'SERVICE_TYPE_NOT_OFFERED',
        `Service type '${serviceTypeId}' is not offered by dealership '${dealershipId}'.`,
      );
    }
    return row;
  }

  #endsAt(startsAtMs: number, durationMinutes: number): number {
    const endsAtMs = startsAtMs + durationMinutes * 60_000;
    if (!Number.isSafeInteger(endsAtMs) || !Number.isFinite(new Date(endsAtMs).getTime())) {
      throw badRequest('INVALID_TIMESTAMP', 'The requested appointment interval is out of range.');
    }
    return endsAtMs;
  }

  #availableTechnicianCount(
    dealershipId: string,
    serviceTypeId: string,
    startsAtMs: number,
    endsAtMs: number,
  ): number {
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM technicians technician
         WHERE technician.dealership_id = ?
           AND technician.active = 1
           AND NOT EXISTS (
             SELECT 1
             FROM service_type_skills required_skill
             WHERE required_skill.service_type_id = ?
               AND NOT EXISTS (
                 SELECT 1
                 FROM technician_skills possessed_skill
                 WHERE possessed_skill.technician_id = technician.id
                   AND possessed_skill.skill_id = required_skill.skill_id
               )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM appointments appointment
             WHERE appointment.technician_id = technician.id
               AND appointment.status = 'confirmed'
               AND appointment.starts_at_ms < ?
               AND ? < appointment.ends_at_ms
           )`,
      )
      .get(dealershipId, serviceTypeId, endsAtMs, startsAtMs) as unknown as CountRow;
    return Number(row.count);
  }

  #availableBayCount(dealershipId: string, startsAtMs: number, endsAtMs: number): number {
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM service_bays service_bay
         WHERE service_bay.dealership_id = ?
           AND service_bay.active = 1
           AND NOT EXISTS (
             SELECT 1
             FROM appointments appointment
             WHERE appointment.service_bay_id = service_bay.id
               AND appointment.status = 'confirmed'
               AND appointment.starts_at_ms < ?
               AND ? < appointment.ends_at_ms
           )`,
      )
      .get(dealershipId, endsAtMs, startsAtMs) as unknown as CountRow;
    return Number(row.count);
  }

  #findAvailableTechnician(
    dealershipId: string,
    serviceTypeId: string,
    startsAtMs: number,
    endsAtMs: number,
  ): string | null {
    const row = this.#database
      .prepare(
        `SELECT technician.id
         FROM technicians technician
         WHERE technician.dealership_id = ?
           AND technician.active = 1
           AND NOT EXISTS (
             SELECT 1
             FROM service_type_skills required_skill
             WHERE required_skill.service_type_id = ?
               AND NOT EXISTS (
                 SELECT 1
                 FROM technician_skills possessed_skill
                 WHERE possessed_skill.technician_id = technician.id
                   AND possessed_skill.skill_id = required_skill.skill_id
               )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM appointments appointment
             WHERE appointment.technician_id = technician.id
               AND appointment.status = 'confirmed'
               AND appointment.starts_at_ms < ?
               AND ? < appointment.ends_at_ms
           )
         ORDER BY technician.id
         LIMIT 1`,
      )
      .get(dealershipId, serviceTypeId, endsAtMs, startsAtMs) as unknown as IdRow | undefined;
    return row?.id ?? null;
  }

  #findAvailableBay(dealershipId: string, startsAtMs: number, endsAtMs: number): string | null {
    const row = this.#database
      .prepare(
        `SELECT service_bay.id
         FROM service_bays service_bay
         WHERE service_bay.dealership_id = ?
           AND service_bay.active = 1
           AND NOT EXISTS (
             SELECT 1
             FROM appointments appointment
             WHERE appointment.service_bay_id = service_bay.id
               AND appointment.status = 'confirmed'
               AND appointment.starts_at_ms < ?
               AND ? < appointment.ends_at_ms
           )
         ORDER BY service_bay.id
         LIMIT 1`,
      )
      .get(dealershipId, endsAtMs, startsAtMs) as unknown as IdRow | undefined;
    return row?.id ?? null;
  }

  #findAppointment(id: string): Appointment | null {
    const row = this.#database
      .prepare(`${APPOINTMENT_SELECT} WHERE appointment.id = ?`)
      .get(id) as unknown as AppointmentRow | undefined;
    return row === undefined ? null : this.#mapAppointment(row);
  }

  #requireAppointment(id: string): Appointment {
    const appointment = this.#findAppointment(id);
    if (appointment === null) {
      throw new Error(`Appointment '${id}' could not be reloaded after persistence.`);
    }
    return appointment;
  }

  #mapAppointment(row: AppointmentRow): Appointment {
    if (row.status !== 'confirmed' && row.status !== 'cancelled') {
      throw new Error(`Unsupported persisted appointment status '${row.status}'.`);
    }

    return {
      id: row.id,
      status: row.status,
      startsAt: toIsoString(Number(row.starts_at_ms)),
      endsAt: toIsoString(Number(row.ends_at_ms)),
      createdAt: toIsoString(Number(row.created_at_ms)),
      cancelledAt: row.cancelled_at_ms === null ? null : toIsoString(Number(row.cancelled_at_ms)),
      dealership: {
        id: row.dealership_id,
        name: row.dealership_name,
        timezone: row.dealership_timezone,
      },
      customer: {
        id: row.customer_id,
        name: row.customer_name,
        email: row.customer_email,
      },
      vehicle: {
        id: row.vehicle_id,
        vin: row.vehicle_vin,
        make: row.vehicle_make,
        model: row.vehicle_model,
      },
      serviceType: {
        id: row.service_type_id,
        name: row.service_type_name,
        durationMinutes: Number(row.duration_minutes),
      },
      technician: {
        id: row.technician_id,
        name: row.technician_name,
      },
      serviceBay: {
        id: row.service_bay_id,
        name: row.service_bay_name,
      },
    };
  }

  #immediateTransaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error: unknown) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // Preserve the original failure when rollback is no longer possible.
      }
      throw this.#translateSqliteError(error);
    }
  }

  #translateSqliteError(error: unknown): unknown {
    if (error instanceof ApplicationError) {
      return error;
    }
    if (error instanceof Error) {
      if (
        error.message.includes('technician_overlap') ||
        error.message.includes('service_bay_overlap')
      ) {
        return conflict(
          'NO_AVAILABILITY',
          'The requested interval was allocated concurrently; choose another time.',
        );
      }
      if (error.message.includes('database is locked')) {
        return new ApplicationError(
          503,
          'SCHEDULER_BUSY',
          'Service temporarily unavailable',
          'The booking store is busy; retry the request shortly with the same Idempotency-Key.',
        );
      }
    }
    return error;
  }
}
