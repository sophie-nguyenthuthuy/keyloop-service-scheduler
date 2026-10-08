import { collectDefaultMetrics, Counter, Histogram, Registry } from '@prometheus-io/client';

import type { BookingOutcome, SchedulerMetrics } from '../application/metrics-port.js';

export class ServiceMetrics implements SchedulerMetrics {
  readonly registry = new Registry();

  readonly #bookingAttempts = new Counter({
    name: 'keyloop_booking_attempts_total',
    help: 'Number of booking attempts by outcome.',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly #availabilityChecks = new Counter({
    name: 'keyloop_availability_checks_total',
    help: 'Number of advisory availability checks by result.',
    labelNames: ['available'] as const,
    registers: [this.registry],
  });

  readonly #httpDuration = new Histogram({
    name: 'keyloop_http_request_duration_seconds',
    help: 'HTTP request latency by method, route and response status.',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ prefix: 'keyloop_process_', register: this.registry });
  }

  recordAvailability(available: boolean): void {
    this.#availabilityChecks.inc({ available: String(available) });
  }

  recordBooking(outcome: BookingOutcome): void {
    this.#bookingAttempts.inc({ outcome });
  }

  observeHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    this.#httpDuration.observe({ method, route, status_code: String(statusCode) }, durationSeconds);
  }
}
