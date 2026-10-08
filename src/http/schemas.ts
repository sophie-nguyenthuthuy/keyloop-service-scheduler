import { Type } from '@sinclair/typebox';

const Identifier = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
});

const Timestamp = Type.String({
  description: 'ISO-8601 timestamp containing Z or an explicit UTC offset.',
  examples: ['2030-01-15T09:00:00Z'],
});

export const DealerParamsSchema = Type.Object({ id: Identifier }, { additionalProperties: false });

export const AppointmentParamsSchema = Type.Object(
  { id: Identifier },
  { additionalProperties: false },
);

export const AvailabilityQuerySchema = Type.Object(
  {
    serviceTypeId: Identifier,
    startsAt: Timestamp,
  },
  { additionalProperties: false },
);

export const CreateAppointmentBodySchema = Type.Object(
  {
    dealershipId: Identifier,
    customerId: Identifier,
    vehicleId: Identifier,
    serviceTypeId: Identifier,
    startsAt: Timestamp,
  },
  { additionalProperties: false },
);

export const IdempotencyHeadersSchema = Type.Object(
  {
    'idempotency-key': Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: '^[\\x21-\\x7E]+$',
        description: 'Makes safe retries return the original appointment.',
      }),
    ),
  },
  { additionalProperties: true },
);

export const HealthSchema = Type.Object(
  { status: Type.Union([Type.Literal('ok'), Type.Literal('ready')]) },
  { additionalProperties: false },
);

export const ProblemSchema = Type.Object(
  {
    type: Type.String(),
    title: Type.String(),
    status: Type.Integer(),
    detail: Type.String(),
    instance: Type.String(),
    code: Type.String(),
    requestId: Type.String(),
    errors: Type.Optional(
      Type.Array(
        Type.Object(
          {
            path: Type.String(),
            message: Type.String(),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

export const AvailabilitySchema = Type.Object(
  {
    dealershipId: Identifier,
    serviceTypeId: Identifier,
    startsAt: Timestamp,
    endsAt: Timestamp,
    durationMinutes: Type.Integer({ minimum: 1 }),
    available: Type.Boolean(),
    availableTechnicianCount: Type.Integer({ minimum: 0 }),
    availableBayCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const ReferenceSchema = Type.Object(
  {
    id: Identifier,
    name: Type.String(),
  },
  { additionalProperties: false },
);

export const AppointmentSchema = Type.Object(
  {
    id: Identifier,
    status: Type.Union([Type.Literal('confirmed'), Type.Literal('cancelled')]),
    startsAt: Timestamp,
    endsAt: Timestamp,
    createdAt: Timestamp,
    cancelledAt: Type.Union([Timestamp, Type.Null()]),
    dealership: Type.Object(
      {
        id: Identifier,
        name: Type.String(),
        timezone: Type.String(),
      },
      { additionalProperties: false },
    ),
    customer: Type.Object(
      {
        id: Identifier,
        name: Type.String(),
        email: Type.String(),
      },
      { additionalProperties: false },
    ),
    vehicle: Type.Object(
      {
        id: Identifier,
        vin: Type.String(),
        make: Type.String(),
        model: Type.String(),
      },
      { additionalProperties: false },
    ),
    serviceType: Type.Object(
      {
        id: Identifier,
        name: Type.String(),
        durationMinutes: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    technician: ReferenceSchema,
    serviceBay: ReferenceSchema,
  },
  { additionalProperties: false },
);
