import { createHash } from 'node:crypto';

import { ApplicationError, badRequest, notFound } from '../domain/errors.js';
import type {
  AllocationResult,
  Appointment,
  Availability,
  AvailabilityQuery,
  BookingCommand,
  Clock,
  SchedulerRepository,
} from '../domain/models.js';
import { parseOffsetDateTime } from '../domain/time.js';
import { noOpSchedulerMetrics, type SchedulerMetrics } from './metrics-port.js';

const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,128}$/;

export interface SchedulerServiceDependencies {
  repository: SchedulerRepository;
  clock: Clock;
  idGenerator: () => string;
  metrics?: SchedulerMetrics;
}

function requestFingerprint(command: BookingCommand, startsAtMs: number): string {
  const canonicalRequest = JSON.stringify([
    command.dealershipId,
    command.customerId,
    command.vehicleId,
    command.serviceTypeId,
    startsAtMs,
  ]);
  return createHash('sha256').update(canonicalRequest).digest('hex');
}

export class SchedulerService {
  readonly #repository: SchedulerRepository;
  readonly #clock: Clock;
  readonly #idGenerator: () => string;
  readonly #metrics: SchedulerMetrics;

  constructor(dependencies: SchedulerServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock;
    this.#idGenerator = dependencies.idGenerator;
    this.#metrics = dependencies.metrics ?? noOpSchedulerMetrics;
  }

  getAvailability(query: AvailabilityQuery): Availability {
    const startsAtMs = parseOffsetDateTime(query.startsAt);
    const availability = this.#repository.getAvailability({
      dealershipId: query.dealershipId,
      serviceTypeId: query.serviceTypeId,
      startsAtMs,
    });
    this.#metrics.recordAvailability(availability.available);
    return availability;
  }

  createAppointment(command: BookingCommand): AllocationResult {
    const startsAtMs = parseOffsetDateTime(command.startsAt);
    const idempotencyKey = this.#validateIdempotencyKey(command.idempotencyKey);
    const createdAtMs = this.#clock().getTime();
    if (!Number.isFinite(createdAtMs)) {
      throw new Error('The configured clock returned an invalid date.');
    }

    try {
      const result = this.#repository.allocateAppointment({
        appointmentId: this.#idGenerator(),
        dealershipId: command.dealershipId,
        customerId: command.customerId,
        vehicleId: command.vehicleId,
        serviceTypeId: command.serviceTypeId,
        startsAtMs,
        createdAtMs,
        idempotencyKey,
        requestFingerprint: requestFingerprint(command, startsAtMs),
      });
      this.#metrics.recordBooking(result.replayed ? 'replayed' : 'confirmed');
      return result;
    } catch (error: unknown) {
      if (error instanceof ApplicationError) {
        this.#metrics.recordBooking(error.status === 409 ? 'conflict' : 'rejected');
      } else {
        this.#metrics.recordBooking('error');
      }
      throw error;
    }
  }

  getAppointment(id: string): Appointment {
    const appointment = this.#repository.getAppointment(id);
    if (appointment === null) {
      throw notFound('APPOINTMENT_NOT_FOUND', `Appointment '${id}' does not exist.`);
    }
    return appointment;
  }

  isReady(): boolean {
    return this.#repository.isReady();
  }

  #validateIdempotencyKey(value: string | undefined): string | null {
    if (value === undefined) {
      return null;
    }
    if (!IDEMPOTENCY_KEY.test(value)) {
      throw badRequest(
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key must contain 1-128 visible ASCII characters.',
      );
    }
    return value;
  }
}
