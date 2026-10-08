# Keyloop Unified Service Scheduler

Backend service-layer submission for **Scenario A: The Unified Service Scheduler** in the Keyloop Engineering Team Lead technical assessment.

The service accepts a requested dealership, customer, vehicle, service type, and start time; finds one qualified technician and one service bay that are free for the service's full duration; and persists a confirmed appointment. The important correctness property is that the write transaction rechecks both resources before it commits, so a preceding availability response can never reserve capacity.

## What is included

- Fastify REST API with TypeBox request and response schemas
- Generated OpenAPI document and interactive Swagger UI
- Embedded, persistent SQLite database using Node.js `node:sqlite`
- Atomic technician-and-bay allocation with half-open time intervals
- Optional idempotent appointment creation
- Structured request logging, health probes, and Prometheus metrics
- Deterministic seed data and a runnable demonstration harness
- Unit and integration tests using the built-in Node.js test runner
- TypeScript strict mode, ESLint, Prettier, build verification, Dockerfile, and CI

For the architecture and engineering decisions, see [DESIGN.md](./DESIGN.md). For individual API calls, see [docs/API_EXAMPLES.md](./docs/API_EXAMPLES.md). A ready-to-record presentation is in [docs/VIDEO_WALKTHROUGH.md](./docs/VIDEO_WALKTHROUGH.md).

## Quick start

### Prerequisites

- Node.js 24 or newer (`.nvmrc` is included)
- npm 11 or newer

No external database, migration tool, or global package is required.

```bash
nvm use
npm ci
npm run dev
```

If `nvm` is unavailable, confirm `node --version` reports version 24 or later, then run the final two commands.

The defaults bind the service to `http://127.0.0.1:3000` and persist data in `./data/scheduler.sqlite`. The directory and schema are created automatically, and deterministic demo records are inserted when needed.

Once the server is running:

- Swagger UI: <http://127.0.0.1:3000/docs>
- OpenAPI JSON: <http://127.0.0.1:3000/openapi.json>
- Liveness: <http://127.0.0.1:3000/health/live>
- Readiness: <http://127.0.0.1:3000/health/ready>
- Prometheus metrics: <http://127.0.0.1:3000/metrics>

### Run the guided demo

From the repository root:

```bash
npm run demo
```

The self-contained demo uses Fastify's in-process request injection and a fresh in-memory database. It checks availability, creates and retrieves an appointment, replays the same idempotent request, and proves that an overlapping request cannot take the already-booked resources. The development server does not need to be running.

## Demo data

The application seeds a deliberately small, deterministic dealership. These are stable IDs intended for cURL, tests, and the video walkthrough.

| Entity       | ID                   | Demo purpose                                                     |
| ------------ | -------------------- | ---------------------------------------------------------------- |
| Dealership   | `dealer-1`           | Keyloop Central (`Europe/London`)                                |
| Customer     | `customer-1`         | Sophie Carter; successful booking                                |
| Customer     | `customer-2`         | Jordan Lee; conflicting booking                                  |
| Vehicle      | `vehicle-1`          | Volkswagen Golf, VIN `WVWZZZ1JZXW000001`; owned by `customer-1`  |
| Vehicle      | `vehicle-2`          | BMW 3 Series, VIN `WBA3A5C50DF000001`; owned by `customer-2`     |
| Service type | `service-oil`        | Oil and Filter Service, 60 minutes; requires `skill-maintenance` |
| Service type | `service-diagnostic` | Vehicle Diagnostic, 90 minutes; requires `skill-diagnostics`     |
| Technician   | `tech-1`             | Alex Morgan; active; has `skill-maintenance`                     |
| Technician   | `tech-2`             | Priya Shah; active; has `skill-diagnostics`                      |
| Service bay  | `bay-1`              | Service Bay 1; active                                            |
| Service bay  | `bay-2`              | Reserve Bay; inactive and never supplies capacity                |

Each service has one qualified technician, and the dealership has one active bay. The conflict demonstration is therefore unambiguous: an overlapping request is rejected because a booking requires **both** resource types for the entire interval.

## API at a glance

| Method | Route                                  | Purpose                                                    |
| ------ | -------------------------------------- | ---------------------------------------------------------- |
| `GET`  | `/health/live`                         | Confirms that the process is running                       |
| `GET`  | `/health/ready`                        | Confirms that the database can serve requests              |
| `GET`  | `/metrics`                             | Exposes Prometheus-format application and process metrics  |
| `GET`  | `/openapi.json`                        | Returns the generated OpenAPI contract                     |
| `GET`  | `/docs`                                | Serves Swagger UI                                          |
| `GET`  | `/api/v1/dealerships/:id/availability` | Checks advisory technician and bay availability            |
| `POST` | `/api/v1/appointments`                 | Atomically allocates resources and persists an appointment |
| `GET`  | `/api/v1/appointments/:id`             | Retrieves the persisted appointment                        |

All timestamps accepted by the API must be ISO 8601 date-times with an explicit `Z` or numeric UTC offset. They are normalized to UTC for storage and responses.

### Check availability

```bash
curl --get 'http://127.0.0.1:3000/api/v1/dealerships/dealer-1/availability' \
  --data-urlencode 'serviceTypeId=service-oil' \
  --data-urlencode 'startsAt=2030-01-15T09:00:00+07:00'
```

Availability is advisory. Another request may book the returned resource before the caller creates its appointment, so `POST /appointments` always performs the decisive check again inside its transaction.

### Create an appointment

```bash
curl --include \
  --request POST 'http://127.0.0.1:3000/api/v1/appointments' \
  --header 'content-type: application/json' \
  --header 'idempotency-key: readme-happy-path-001' \
  --data '{
    "dealershipId": "dealer-1",
    "customerId": "customer-1",
    "vehicleId": "vehicle-1",
    "serviceTypeId": "service-oil",
    "startsAt": "2030-01-15T09:00:00+07:00"
  }'
```

The 60-minute service is stored as the UTC interval `[2030-01-15T02:00:00.000Z, 2030-01-15T03:00:00.000Z)`. A request beginning exactly at the first appointment's end does not overlap it.

### Demonstrate a conflict

After the preceding booking, submit a different vehicle for the same interval:

```bash
curl --include \
  --request POST 'http://127.0.0.1:3000/api/v1/appointments' \
  --header 'content-type: application/json' \
  --header 'idempotency-key: readme-conflict-001' \
  --data '{
    "dealershipId": "dealer-1",
    "customerId": "customer-2",
    "vehicleId": "vehicle-2",
    "serviceTypeId": "service-oil",
    "startsAt": "2030-01-15T09:00:00+07:00"
  }'
```

The service returns `409 Conflict` as an `application/problem+json` response because no complete technician-and-bay allocation remains. More examples, including retrieval and idempotent replay, are in [docs/API_EXAMPLES.md](./docs/API_EXAMPLES.md).

## Commands

| Command                 | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `npm run dev`           | Run the TypeScript server in watch mode                       |
| `npm run build`         | Compile production JavaScript into `dist/`                    |
| `npm start`             | Run the compiled server                                       |
| `npm run demo`          | Exercise the main workflow in a self-contained in-process API |
| `npm test`              | Run the test suite                                            |
| `npm run test:coverage` | Run tests with Node.js coverage reporting                     |
| `npm run typecheck`     | Run strict TypeScript checking without emitting files         |
| `npm run lint`          | Run ESLint                                                    |
| `npm run format:check`  | Check Prettier formatting                                     |
| `npm run format`        | Apply Prettier formatting                                     |
| `npm run verify`        | Run formatting, linting, types, tests, and build              |

Before opening a pull request or recording the walkthrough, run:

```bash
npm run verify
```

The same quality gate runs in GitHub Actions.

## Configuration

The service reads standard environment variables. The `.env.example` file is a reference; export variables in the shell or inject them through the process/container environment.

| Variable        | Default                   | Meaning                            |
| --------------- | ------------------------- | ---------------------------------- |
| `HOST`          | `127.0.0.1`               | Interface on which Fastify listens |
| `PORT`          | `3000`                    | HTTP port                          |
| `DATABASE_PATH` | `./data/scheduler.sqlite` | Persistent SQLite database file    |
| `LOG_LEVEL`     | `info`                    | Fastify/Pino logging level         |

Example with an isolated database:

```bash
DATABASE_PATH=./data/local-review.sqlite LOG_LEVEL=debug npm run dev
```

To run the compiled application:

```bash
npm run build
DATABASE_PATH=./data/production-like.sqlite npm start
```

### Docker

```bash
docker build --tag keyloop-service-scheduler .
docker run --rm \
  --publish 3000:3000 \
  --mount source=keyloop-scheduler-data,target=/app/data \
  keyloop-service-scheduler
```

The named volume preserves the SQLite file between container runs.

## Error contract

Errors use `application/problem+json` and include stable machine-readable fields:

```json
{
  "type": "urn:keyloop:problem:no-availability",
  "title": "Booking conflict",
  "status": 409,
  "detail": "No qualified technician and service bay are both available for the requested interval.",
  "instance": "/api/v1/appointments",
  "code": "NO_AVAILABILITY",
  "requestId": "req-7"
}
```

Clients should branch on `status` and `code`, not on the human-readable `detail`. Fastify assigns a request ID to every call, echoes it in the problem response, and includes it in structured logs.

## Correctness model

- The service type owns the appointment duration; callers cannot override it.
- Time ranges are half-open: `[startsAt, endsAt)`. Back-to-back bookings are valid.
- A technician must be active, belong to the dealership, and have the required service skill.
- A service bay must be active and belong to the dealership.
- Only `confirmed` appointments consume resource capacity.
- Availability is a read-only hint. Booking atomically repeats validation and allocation.
- Candidate resources are ordered by ID, making allocation and tests deterministic.
- An `Idempotency-Key` replay with the same request returns the original appointment; it does not consume capacity twice.
- A syntactically valid offset-aware timestamp is accepted even when it is in the past; future-only and dealership-hours enforcement are explicit product decisions outside this MVP.

## Project structure

```text
src/
  app.ts                 Fastify composition root
  server.ts              Process startup and shutdown
  domain/                Domain types, errors, and interval rules
  application/           SchedulerService and repository/metrics ports
  infrastructure/        SQLite adapter, schema, seeds, and metrics
  http/                  TypeBox schemas and Fastify route handlers
scripts/
  demo.ts                Executable client-side test harness
test/                     Unit and integration tests
docs/                     API examples and video script
DESIGN.md                 Architecture and decision record
```

The dependency direction is intentional: HTTP handlers call `SchedulerService`; the service depends on the `SchedulerRepository` interface; and only the infrastructure adapter knows SQLite. A PostgreSQL adapter can therefore replace SQLite without moving booking rules into controllers.

## Testing and quality strategy

The 17-test suite concentrates on the business risks rather than merely exercising lines:

- full-interval technician and bay matching
- service-skill eligibility and active-resource filtering
- successful persistence and retrieval
- overlapping appointment rejection
- valid back-to-back half-open intervals
- advisory availability before and after a booking
- idempotent replay without a second row
- input validation, missing references, and ownership checks
- health and observability endpoints

Tests use isolated temporary databases and deterministic seed data. HTTP tests exercise the same Fastify schemas and handlers as production. `npm run verify` additionally enforces formatting, lint rules, strict typing, and a clean production build.

## Deliberate tradeoffs and production path

SQLite and `node:sqlite` keep the assessment reproducible with one command and still provide real durable storage and transactions. The tradeoff is a single-writer architecture with synchronous database calls. That is appropriate for a compact demonstration, not a horizontally scaled dealer network.

The repository port marks the migration boundary. A production version would use PostgreSQL, connection pooling, and database-enforced overlap protection with `tstzrange` plus GiST exclusion constraints for both `technician_id` and `service_bay_id`. It would add retry-on-allocation-race, OpenTelemetry traces, authentication and dealership authorization, working calendars and leave, rate limits, audit events, backups, and multi-instance deployment.

See [DESIGN.md](./DESIGN.md) for the full rationale, failure modes, scaling plan, security posture, and acceptance-criteria traceability.

## AI Collaboration Narrative

This solution was developed with **OpenAI Codex used heavily as an engineering collaborator**, including design exploration, implementation scaffolding, test generation, review, and documentation. That use is disclosed directly because the assessment asks for evidence of direction, verification, refinement, and ownership rather than pretending AI was limited to autocomplete.

### Strategy for directing the AI

I first constrained the problem around testable invariants instead of asking for a generic scheduler: one dealership, a service-owned duration, an offset-aware start time, one qualified technician plus one active bay for the whole interval, half-open ranges, and only confirmed appointments consuming capacity. I also set explicit boundaries: backend only, embedded persistence for a zero-setup review, a repository port for a PostgreSQL evolution, and no auth, calendars, notifications, payments, or rescheduling in the MVP.

Work was split into focused streams. One Codex agent extracted and challenged the assessment requirements; another developed and reviewed the architecture and implementation; another produced the documentation against the actual route and seed contracts. Parallel review was used to expose inconsistencies instead of allowing a single generated draft to become the design by default.

### Verification and refinement

Generated output was treated as a hypothesis. The implementation was checked through:

1. strict TypeScript compilation and explicit boundary schemas;
2. ESLint and Prettier quality gates;
3. domain, repository, concurrency-sensitive, and HTTP contract tests;
4. a production build and startup check;
5. live happy-path, idempotent-replay, persistence, and conflict demonstrations;
6. independent review of resource overlap semantics, database locking, API errors, and documentation claims.

The most important refinement was preserving the difference between an advisory availability query and authoritative allocation. The API may report a slot as free, but appointment creation begins a write transaction and repeats the complete eligibility and overlap check before inserting. The design was also tightened around explicit-offset timestamps, half-open intervals, deterministic resource selection, stable problem codes, and an honest SQLite-to-PostgreSQL migration path.

### Ownership

AI accelerated implementation, but it did not own the acceptance criteria or make unreviewed product decisions. The architectural choices and omissions are explicit in [DESIGN.md](./DESIGN.md), and every important claim is intended to be reproducible with `npm run verify`, `npm run demo`, or the cURL sequence in [docs/API_EXAMPLES.md](./docs/API_EXAMPLES.md). I take responsibility for the resulting behavior, tradeoffs, and production recommendations, and I would use the same evidence-based review process for subsequent AI-assisted changes.

## Scope boundaries

The MVP intentionally excludes authentication, authorization, future-only scheduling, dealership working hours, technician leave, bay capabilities beyond active/inactive state, notifications, payments, cancellations, rescheduling, and alternative-slot recommendations. Those are product decisions and future workflows, not silent assumptions hidden in the code.
