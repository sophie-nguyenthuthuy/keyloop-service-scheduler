export type Clock = () => Date;

export interface BookingCommand {
  dealershipId: string;
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  startsAt: string;
  idempotencyKey?: string;
}

export interface AvailabilityQuery {
  dealershipId: string;
  serviceTypeId: string;
  startsAt: string;
}

export interface AllocationRequest {
  appointmentId: string;
  dealershipId: string;
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  startsAtMs: number;
  createdAtMs: number;
  requestFingerprint: string;
  idempotencyKey: string | null;
}

export interface AvailabilityRequest {
  dealershipId: string;
  serviceTypeId: string;
  startsAtMs: number;
}

export interface Availability {
  dealershipId: string;
  serviceTypeId: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  available: boolean;
  availableTechnicianCount: number;
  availableBayCount: number;
}

export interface Appointment {
  id: string;
  status: 'confirmed' | 'cancelled';
  startsAt: string;
  endsAt: string;
  createdAt: string;
  cancelledAt: string | null;
  dealership: {
    id: string;
    name: string;
    timezone: string;
  };
  customer: {
    id: string;
    name: string;
    email: string;
  };
  vehicle: {
    id: string;
    vin: string;
    make: string;
    model: string;
  };
  serviceType: {
    id: string;
    name: string;
    durationMinutes: number;
  };
  technician: {
    id: string;
    name: string;
  };
  serviceBay: {
    id: string;
    name: string;
  };
}

export interface AllocationResult {
  appointment: Appointment;
  replayed: boolean;
}

export interface SchedulerRepository {
  getAvailability(request: AvailabilityRequest): Availability;
  allocateAppointment(request: AllocationRequest): AllocationResult;
  getAppointment(id: string): Appointment | null;
  isReady(): boolean;
  close(): void;
}
