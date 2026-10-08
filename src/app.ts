import { randomUUID } from 'node:crypto';

import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import { SchedulerService } from './application/scheduler-service.js';
import { ApplicationError } from './domain/errors.js';
import type { Clock } from './domain/models.js';
import { registerRoutes } from './http/routes.js';
import { ServiceMetrics } from './infrastructure/metrics.js';
import { SqliteSchedulerRepository } from './infrastructure/sqlite-scheduler-repository.js';

export interface BuildAppOptions {
  databasePath?: string;
  logger?: boolean | { level?: string };
  clock?: Clock;
  idGenerator?: () => string;
}

interface ValidationIssue {
  instancePath?: string;
  message?: string;
}

function requestIdFromHeader(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate !== undefined && /^[\x21-\x7E]{1,128}$/.test(candidate)) {
    return candidate;
  }
  return randomUUID();
}

function problemType(code: string): string {
  return `urn:keyloop:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    genReqId: (request) => requestIdFromHeader(request.headers['x-request-id']),
  });
  const repository = new SqliteSchedulerRepository(
    options.databasePath ?? process.env.DATABASE_PATH ?? './data/scheduler.sqlite',
  );
  const metrics = new ServiceMetrics();
  const scheduler = new SchedulerService({
    repository,
    clock: options.clock ?? (() => new Date()),
    idGenerator: options.idGenerator ?? (() => `appointment-${randomUUID()}`),
    metrics,
  });
  const requestStartedAt = new WeakMap<object, bigint>();

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Keyloop Unified Service Scheduler API',
        description:
          'Scenario A backend: transactionally allocates a qualified technician and service bay.',
        version: '1.0.0',
      },
      tags: [
        { name: 'Scheduling', description: 'Advisory service availability.' },
        { name: 'Appointments', description: 'Authoritative appointment operations.' },
        { name: 'Operations', description: 'Health and readiness endpoints.' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  app.addHook('onRequest', (request, reply, done) => {
    requestStartedAt.set(request, process.hrtime.bigint());
    reply.header('X-Request-Id', request.id);
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const startedAt = requestStartedAt.get(request);
    if (startedAt !== undefined) {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      metrics.observeHttpRequest(
        request.method,
        request.routeOptions.url ?? 'unmatched',
        reply.statusCode,
        durationSeconds,
      );
    }
    done();
  });

  app.addHook('onClose', (_instance, done) => {
    repository.close();
    done();
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .type('application/problem+json')
      .send({
        type: problemType('ROUTE_NOT_FOUND'),
        title: 'Route not found',
        status: 404,
        detail: `No route matches ${request.method} ${request.url}.`,
        instance: request.url,
        code: 'ROUTE_NOT_FOUND',
        requestId: request.id,
      }),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApplicationError) {
      const logContext = { code: error.code, status: error.status };
      if (error.status >= 500) {
        request.log.error(logContext, error.message);
      } else {
        request.log.warn(logContext, error.message);
      }
      return reply
        .status(error.status)
        .type('application/problem+json')
        .send({
          type: problemType(error.code),
          title: error.title,
          status: error.status,
          detail: error.message,
          instance: request.url,
          code: error.code,
          requestId: request.id,
        });
    }

    if (error.validation !== undefined) {
      const issues = error.validation as ValidationIssue[];
      return reply
        .status(400)
        .type('application/problem+json')
        .send({
          type: problemType('VALIDATION_ERROR'),
          title: 'Invalid request',
          status: 400,
          detail: 'The request does not match the API contract.',
          instance: request.url,
          code: 'VALIDATION_ERROR',
          requestId: request.id,
          errors: issues.map((issue) => ({
            path: issue.instancePath ?? '',
            message: issue.message ?? 'is invalid',
          })),
        });
    }

    request.log.error({ err: error }, 'unhandled request error');
    return reply
      .status(500)
      .type('application/problem+json')
      .send({
        type: problemType('INTERNAL_ERROR'),
        title: 'Internal server error',
        status: 500,
        detail: 'An unexpected error occurred.',
        instance: request.url,
        code: 'INTERNAL_ERROR',
        requestId: request.id,
      });
  });

  registerRoutes(app, { scheduler, metrics });
  return app;
}
