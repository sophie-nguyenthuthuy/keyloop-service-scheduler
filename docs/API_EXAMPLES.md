# API Examples

These commands exercise the complete Scenario A acceptance path. They assume the service is running on the default address and use the deterministic seed IDs documented in the README.

## 1. Start with an isolated database

Terminal 1:

```bash
cd /path/to/keyloop-service-scheduler
npm ci
DATABASE_PATH=./data/api-examples.sqlite npm run dev
```

Terminal 2:

```bash
cd /path/to/keyloop-service-scheduler
export BASE_URL='http://127.0.0.1:3000'
export STARTS_AT='2030-01-15T09:00:00+07:00'
```

`jq` is optional but makes responses easier to read. Omit the final `| jq` from examples if it is not installed.

To repeat this guide without colliding with an earlier run, choose a different `DATABASE_PATH`, start time, and idempotency-key suffix.

## 2. Operational endpoints

### Liveness

```bash
curl --silent --show-error "$BASE_URL/health/live" | jq
```

Expected status: `200 OK`.

### Database readiness

```bash
curl --silent --show-error "$BASE_URL/health/ready" | jq
```

Expected status: `200 OK` while the database is queryable; otherwise `503 Service Unavailable` with a problem response.

### OpenAPI contract

```bash
curl --silent --show-error "$BASE_URL/openapi.json" | jq '.info, .paths | keys'
```

Interactive Swagger UI is available at <http://127.0.0.1:3000/docs>.

### Metrics

```bash
curl --silent --show-error "$BASE_URL/metrics" | sed -n '1,40p'
```

Expected content type: Prometheus text exposition.

## 3. Check advisory availability

```bash
curl --silent --show-error --get \
  "$BASE_URL/api/v1/dealerships/dealer-1/availability" \
  --data-urlencode 'serviceTypeId=service-oil' \
  --data-urlencode "startsAt=$STARTS_AT" | jq
```

Representative response before booking:

```json
{
  "dealershipId": "dealer-1",
  "serviceTypeId": "service-oil",
  "startsAt": "2030-01-15T02:00:00.000Z",
  "endsAt": "2030-01-15T03:00:00.000Z",
  "durationMinutes": 60,
  "available": true,
  "availableTechnicianCount": 1,
  "availableBayCount": 1
}
```

The counts are a point-in-time observation, not a reservation.

## 4. Create a confirmed appointment

Use a unique idempotency key for this walkthrough:

```bash
export IDEMPOTENCY_KEY='api-guide-happy-001'
```

Create and save the response:

```bash
curl --silent --show-error \
  --dump-header /tmp/keyloop-create-headers.txt \
  --request POST "$BASE_URL/api/v1/appointments" \
  --header 'content-type: application/json' \
  --header "idempotency-key: $IDEMPOTENCY_KEY" \
  --data "{
    \"dealershipId\": \"dealer-1\",
    \"customerId\": \"customer-1\",
    \"vehicleId\": \"vehicle-1\",
    \"serviceTypeId\": \"service-oil\",
    \"startsAt\": \"$STARTS_AT\"
  }" \
  --output /tmp/keyloop-appointment.json

sed -n '1,20p' /tmp/keyloop-create-headers.txt
jq . /tmp/keyloop-appointment.json
export APPOINTMENT_ID="$(jq --raw-output '.id' /tmp/keyloop-appointment.json)"
```

Expected result: `201 Created`. The response contains the selected `technician`, `serviceBay`, customer, vehicle, service type, normalized UTC interval, and `confirmed` status.

## 5. Retrieve the persisted record

```bash
curl --silent --show-error \
  "$BASE_URL/api/v1/appointments/$APPOINTMENT_ID" | jq
```

The returned ID and resource associations should match the create response. Stop and restart the server with the same `DATABASE_PATH`, then repeat this command to demonstrate disk persistence.

## 6. Replay the same create safely

```bash
curl --silent --show-error --include \
  --request POST "$BASE_URL/api/v1/appointments" \
  --header 'content-type: application/json' \
  --header "idempotency-key: $IDEMPOTENCY_KEY" \
  --data "{
    \"dealershipId\": \"dealer-1\",
    \"customerId\": \"customer-1\",
    \"vehicleId\": \"vehicle-1\",
    \"serviceTypeId\": \"service-oil\",
    \"startsAt\": \"$STARTS_AT\"
  }"
```

The body contains the same appointment ID. The `Idempotency-Replayed: true` response header makes the replay visible. No second appointment is inserted.

## 7. Observe availability after booking

```bash
curl --silent --show-error --get \
  "$BASE_URL/api/v1/dealerships/dealer-1/availability" \
  --data-urlencode 'serviceTypeId=service-oil' \
  --data-urlencode "startsAt=$STARTS_AT" | jq
```

The active bay count is now zero, so `available` is false even if another qualified technician remains.

## 8. Prove overlapping allocation is rejected

```bash
curl --silent --show-error --include \
  --request POST "$BASE_URL/api/v1/appointments" \
  --header 'content-type: application/json' \
  --header 'idempotency-key: api-guide-conflict-001' \
  --data "{
    \"dealershipId\": \"dealer-1\",
    \"customerId\": \"customer-2\",
    \"vehicleId\": \"vehicle-2\",
    \"serviceTypeId\": \"service-oil\",
    \"startsAt\": \"$STARTS_AT\"
  }"
```

Expected status: `409 Conflict`. Representative problem response:

```json
{
  "type": "urn:keyloop:problem:no-availability",
  "title": "Booking conflict",
  "status": 409,
  "detail": "No qualified technician and service bay are both available for the requested interval.",
  "instance": "/api/v1/appointments",
  "code": "NO_AVAILABILITY",
  "requestId": "req-8"
}
```

## 9. Prove the end boundary is available

The first service ends at `2030-01-15T10:00:00+07:00`. A second booking may start exactly then because intervals are half-open.

```bash
curl --silent --show-error --include \
  --request POST "$BASE_URL/api/v1/appointments" \
  --header 'content-type: application/json' \
  --header 'idempotency-key: api-guide-back-to-back-001' \
  --data '{
    "dealershipId": "dealer-1",
    "customerId": "customer-2",
    "vehicleId": "vehicle-2",
    "serviceTypeId": "service-oil",
    "startsAt": "2030-01-15T10:00:00+07:00"
  }'
```

Expected status: `201 Created`.

## 10. Validation and domain errors

### Missing UTC offset

```bash
curl --silent --show-error --include \
  --request POST "$BASE_URL/api/v1/appointments" \
  --header 'content-type: application/json' \
  --data '{
    "dealershipId": "dealer-1",
    "customerId": "customer-1",
    "vehicleId": "vehicle-1",
    "serviceTypeId": "service-oil",
    "startsAt": "2030-01-16T09:00:00"
  }'
```

Expected status: `400 Bad Request`. A local-looking time without an offset is deliberately rejected rather than guessed.

### Unknown appointment

```bash
curl --silent --show-error --include \
  "$BASE_URL/api/v1/appointments/appointment-does-not-exist"
```

Expected status: `404 Not Found`.

### Reusing an idempotency key for a different command

```bash
curl --silent --show-error --include \
  --request POST "$BASE_URL/api/v1/appointments" \
  --header 'content-type: application/json' \
  --header "idempotency-key: $IDEMPOTENCY_KEY" \
  --data '{
    "dealershipId": "dealer-1",
    "customerId": "customer-1",
    "vehicleId": "vehicle-1",
    "serviceTypeId": "service-oil",
    "startsAt": "2030-01-17T09:00:00+07:00"
  }'
```

Expected status: `409 Conflict`. An idempotency key names one logical command and cannot be reassigned.

## 11. One-command harness

The repository includes the same core story as an executable client stub. It builds the Fastify application in process, uses a fresh in-memory SQLite database, and does not require the development server:

```bash
npm run demo
```

Use it for the video when showing individual cURL commands would distract from the design discussion.
