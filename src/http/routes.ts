import type { Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import type { SchedulerService } from '../application/scheduler-service.js';
import type { ServiceMetrics } from '../infrastructure/metrics.js';
import {
  AppointmentParamsSchema,
  AppointmentSchema,
  AvailabilityQuerySchema,
  AvailabilitySchema,
  CreateAppointmentBodySchema,
  DealerParamsSchema,
  HealthSchema,
  IdempotencyHeadersSchema,
  ProblemSchema,
} from './schemas.js';

export interface RouteDependencies {
  scheduler: SchedulerService;
  metrics: ServiceMetrics;
}

type DealerParams = Static<typeof DealerParamsSchema>;
type AppointmentParams = Static<typeof AppointmentParamsSchema>;
type AvailabilityQuery = Static<typeof AvailabilityQuerySchema>;
type CreateAppointmentBody = Static<typeof CreateAppointmentBodySchema>;
type IdempotencyHeaders = Static<typeof IdempotencyHeadersSchema>;

export function registerRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.get(
    '/health/live',
    {
      schema: {
        tags: ['Operations'],
        summary: 'Liveness probe',
        response: { 200: HealthSchema },
      },
    },
    () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['Operations'],
        summary: 'Database readiness probe',
        response: { 200: HealthSchema, 503: ProblemSchema },
      },
    },
    (request, reply) => {
      if (dependencies.scheduler.isReady()) {
        return { status: 'ready' as const };
      }
      return reply.status(503).type('application/problem+json').send({
        type: 'urn:keyloop:problem:database-not-ready',
        title: 'Service unavailable',
        status: 503,
        detail: 'The booking database is not ready.',
        instance: request.url,
        code: 'DATABASE_NOT_READY',
        requestId: request.id,
      });
    },
  );

  app.get(
    '/metrics',
    {
      schema: { hide: true },
    },
    async (_request, reply) => {
      const metrics = await dependencies.metrics.registry.metrics();
      return reply.type(dependencies.metrics.registry.contentType).send(metrics);
    },
  );

  app.get(
    '/openapi.json',
    {
      schema: { hide: true },
    },
    () => app.swagger(),
  );

  app.get<{ Params: DealerParams; Querystring: AvailabilityQuery }>(
    '/api/v1/dealerships/:id/availability',
    {
      schema: {
        tags: ['Scheduling'],
        summary: 'Check advisory resource availability',
        description:
          'Checks current availability without reserving resources. Appointment creation is authoritative.',
        params: DealerParamsSchema,
        querystring: AvailabilityQuerySchema,
        response: {
          200: AvailabilitySchema,
          400: ProblemSchema,
          404: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    (request) => {
      const availability = dependencies.scheduler.getAvailability({
        dealershipId: request.params.id,
        serviceTypeId: request.query.serviceTypeId,
        startsAt: request.query.startsAt,
      });
      request.log.info(
        {
          dealershipId: availability.dealershipId,
          serviceTypeId: availability.serviceTypeId,
          available: availability.available,
        },
        'availability checked',
      );
      return availability;
    },
  );

  app.post<{
    Body: CreateAppointmentBody;
    Headers: IdempotencyHeaders;
  }>(
    '/api/v1/appointments',
    {
      schema: {
        tags: ['Appointments'],
        summary: 'Confirm and persist an appointment',
        body: CreateAppointmentBodySchema,
        headers: IdempotencyHeadersSchema,
        response: {
          200: AppointmentSchema,
          201: AppointmentSchema,
          400: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          422: ProblemSchema,
          503: ProblemSchema,
        },
      },
    },
    (request, reply) => {
      const result = dependencies.scheduler.createAppointment({
        ...request.body,
        ...(request.headers['idempotency-key'] === undefined
          ? {}
          : { idempotencyKey: request.headers['idempotency-key'] }),
      });

      request.log.info(
        {
          appointmentId: result.appointment.id,
          dealershipId: result.appointment.dealership.id,
          technicianId: result.appointment.technician.id,
          serviceBayId: result.appointment.serviceBay.id,
          replayed: result.replayed,
        },
        result.replayed ? 'appointment replayed' : 'appointment confirmed',
      );

      reply.header('Location', `/api/v1/appointments/${result.appointment.id}`);
      reply.header('Idempotency-Replayed', String(result.replayed));
      return reply.status(result.replayed ? 200 : 201).send(result.appointment);
    },
  );

  app.get<{ Params: AppointmentParams }>(
    '/api/v1/appointments/:id',
    {
      schema: {
        tags: ['Appointments'],
        summary: 'Retrieve a confirmed appointment',
        params: AppointmentParamsSchema,
        response: {
          200: AppointmentSchema,
          404: ProblemSchema,
        },
      },
    },
    (request) => dependencies.scheduler.getAppointment(request.params.id),
  );
}
