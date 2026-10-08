# 7–8 Minute Video Walkthrough

This is a ready-to-record script and storyboard for the Keyloop submission. At a normal speaking pace it runs approximately 7 minutes 40 seconds, including command execution.

## Recording setup

### Before recording

1. Close personal windows and enable Do Not Disturb.
2. Use a 1920×1080 canvas and enlarge editor/terminal text to at least 16–18 pt.
3. Open these tabs in advance:
   - `DESIGN.md` at the architecture diagram
   - `src/application/scheduler-service.ts`
   - the SQLite repository allocation method
   - the most representative booking test
   - Swagger UI at <http://127.0.0.1:3000/docs>
4. Use a fresh video database and run the quality gate before recording:

```bash
cd /path/to/keyloop-service-scheduler
npm ci
npm run verify
DATABASE_PATH=./data/video-walkthrough.sqlite npm run dev
```

5. In a second terminal, verify the demo is ready:

```bash
cd /path/to/keyloop-service-scheduler
npm run demo
```

If the database was already used, choose a new filename such as `video-walkthrough-2.sqlite` so the initial slot is free.

### QuickTime Player on macOS

1. Open QuickTime Player and choose **File → New Screen Recording**, or press `Shift-Command-5`.
2. Choose **Record Selected Portion** and frame only the editor/browser/terminal area.
3. Under **Options**, select the intended microphone and a clearly named save location.
4. Record a ten-second sample first and check voice level, text legibility, and cursor visibility.

### OBS Studio

1. Set **Settings → Video → Base and Output Resolution** to `1920x1080`, 30 FPS.
2. Add a Window Capture or Display Capture and an Audio Input Capture for the microphone.
3. Prefer MKV while recording so an interrupted session is recoverable; use **File → Remux Recordings** to produce MP4 afterward.
4. Keep the microphone peaking around −12 dB and out of the red.
5. Hide the preview controls from the captured region and make a short test recording.

Do not display environment secrets, unrelated repositories, notifications, or customer data.

## Timecoded storyboard and script

### 0:00–0:35 — Introduction

**On screen:** README title and the short project description.

**Say:**

> Hi, I’m Sophie. I chose Scenario A, the Unified Service Scheduler, and implemented the backend service layer. My focus was the part of this problem that carries the most operational risk: allocating a qualified technician and a service bay without double-booking either resource. The result is a small TypeScript REST service with persistent SQLite storage, an OpenAPI contract, automated tests, observability, and a clear path to PostgreSQL for production.

### 0:35–1:20 — Requirements and assumptions

**On screen:** `DESIGN.md`, sections “Goals and non-goals” and “Assumptions.” Highlight the interval and availability assumptions.

**Say:**

> I made the ambiguous parts explicit. The service type owns duration, input times require an explicit UTC offset and are normalized to UTC, and appointments use half-open intervals, so back-to-back bookings are allowed. A confirmed appointment needs one active bay and one active technician who belongs to the dealership and has the service skill for the entire interval. Only confirmed appointments consume capacity. Most importantly, availability is advisory. It reserves nothing; the create operation rechecks everything atomically.
>
> I kept authentication, calendars, leave, notifications, payments, and rescheduling outside this MVP because each needs a real product decision rather than an invented rule.

### 1:20–2:25 — Architecture and data flow

**On screen:** Mermaid architecture diagram, then booking sequence diagram in `DESIGN.md`.

**Say:**

> The HTTP layer is Fastify with TypeBox schemas, which gives runtime validation, inferred TypeScript types, and generated OpenAPI from one contract. Handlers call SchedulerService. That service depends on a SchedulerRepository port, and the SQLite adapter implements the port. This dependency direction keeps SQL and HTTP concerns out of the use case and makes PostgreSQL an adapter change rather than an application rewrite.
>
> On create, the adapter begins the write transaction before the authoritative reads. It checks an idempotency replay, validates the associations, derives the end time from the service type, and selects a qualified free technician and an active free bay in deterministic ID order. Only when both exist does it insert the confirmed appointment and commit. A competing overlapping request either waits and sees the committed booking or receives a conflict; it cannot allocate the same resource from a stale check.

### 2:25–3:25 — Implementation highlights

**On screen:** Briefly show `SchedulerService`, the repository port, the allocation SQL/transaction, and one boundary test. Avoid scrolling through whole files.

**Say:**

> The code mirrors that diagram. The route does transport validation and mapping. SchedulerService expresses the use case. The adapter owns the short database transaction and the overlap predicate: an existing start before the requested end, and an existing end after the requested start. Because the inequalities are strict, touching boundaries do not conflict.
>
> SQLite is a deliberate assessment tradeoff. Node 24 provides it without a separate database install, so the project is genuinely persistent but starts with one command. It is not presented as horizontally scalable. In production, I would keep this port, add a PostgreSQL adapter, and enforce technician and bay overlap with `tstzrange` GiST exclusion constraints. The API also exposes structured problem responses, request-correlated logs, health probes, and Prometheus metrics.

### 3:25–4:50 — AI collaboration story (1 minute 25 seconds)

**On screen:** README “AI Collaboration Narrative,” then the terminal showing `npm run verify` results.

**Say:**

> I used OpenAI Codex heavily and transparently as an engineering collaborator. I did not begin with “build a scheduler.” I first constrained the problem with explicit invariants, scope boundaries, the service-layer choice, and the expected production evolution. That made the AI optimize inside a reviewed design rather than inventing product behavior.
>
> I split work into focused streams: requirements and architecture review, implementation and scaffold review, and documentation against the actual API contract. Parallel reviewers were useful for challenging the first generated answer, especially around availability versus reservation, database locking, time offsets, and idempotency.
>
> I treated generated code as a hypothesis. Every change had to pass formatting, linting, strict type checking, the Node test suite, and a production build. I also exercised the live happy path, persisted retrieval, idempotent replay, and overlapping conflict. When a claim in the design did not match executable behavior, the claim or implementation had to change. AI accelerated the work; I own the final assumptions, tradeoffs, and behavior, and I can explain and reproduce the evidence rather than relying on generated prose.

### 4:50–6:25 — Live demonstration

**On screen:** Terminal 2. Keep Terminal 1 with server logs visible in a split pane if legible.

**Run:**

```bash
npm run demo
```

**Say while the steps print:**

> The harness is the stubbed client layer. It runs through Fastify in process against a fresh in-memory SQLite database. First it checks the seeded oil-service slot. The service derives a one-hour end time and reports qualified-technician and active-bay counts.
>
> Next it creates the appointment. The response is confirmed and includes the chosen technician and bay as well as the customer and vehicle association. It retrieves the appointment through a separate GET, demonstrating persistence rather than an in-memory response.
>
> The harness then repeats the same create with the same idempotency key. It receives HTTP 200 and the same appointment ID; the real response also carries the `Idempotency-Replayed` header, so a client retry cannot consume capacity twice.
>
> Finally it submits a different customer and vehicle for the same interval. The oil-qualified technician and the only active bay are already occupied. The API returns a 409 problem response and writes no partial appointment. That demonstrates the central invariant: both resource types must be free together for the complete service duration.

**Optional on screen:** Open `/docs` for five seconds and expand `POST /api/v1/appointments`.

**Add:**

> The same calls are available interactively in Swagger and as copy-and-paste cURL examples in the repository.

### 6:25–7:10 — Testing, reliability, and operations

**On screen:** Test names/output, then `/metrics` or the observability section.

**Run if the previous verification output is not already visible:**

```bash
npm test
curl --silent http://127.0.0.1:3000/metrics | sed -n '1,25p'
```

**Say:**

> The tests concentrate on business risk: qualification, inactive resources, overlaps, exact end boundaries, persistence, idempotency, input validation, and HTTP contracts. Readiness checks the database, logs carry a request ID and avoid request bodies, and Prometheus metrics separate business conflicts from platform failures. For production I would add OpenTelemetry traces, tenant-scoped authentication, rate limits, backups, and alerts on 5xx errors, readiness failures, transaction latency, and abnormal conflict rates.

### 7:10–7:45 — Learning, challenges, and close

**On screen:** `DESIGN.md` production evolution or README tradeoffs.

**Say:**

> The main lesson was that scheduling correctness is not an availability-screen problem; it is a transactional invariant. The hardest design choice was balancing a reviewer-friendly zero-setup database with an honest scale story. SQLite makes the solution easy to run, while the repository boundary and PostgreSQL exclusion-constraint design show how I would preserve correctness across replicas. Given more time, I would add dealership calendars, leave, fair allocation policy, alternative-slot suggestions, and PostgreSQL contention tests. Thank you for reviewing the solution.

## Final recording checklist

- Duration is between 5 and 10 minutes.
- Voice is clear and screen text is readable at normal playback size.
- The video includes introduction, design, implementation, 1–2 minute AI story, live demo, lessons, and challenges.
- No secrets, personal notifications, or unrelated files appear.
- `npm run verify` passes in the commit being presented.
- The demo uses a fresh database and shows success, persistence, replay, and conflict.
- The final file plays from beginning to end and has been uploaded with the repository/design links requested by the recruiter.
