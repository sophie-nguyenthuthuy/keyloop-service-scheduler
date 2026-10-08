export type BookingOutcome = 'confirmed' | 'replayed' | 'conflict' | 'rejected' | 'error';

export interface SchedulerMetrics {
  recordAvailability(available: boolean): void;
  recordBooking(outcome: BookingOutcome): void;
}

export const noOpSchedulerMetrics: SchedulerMetrics = {
  recordAvailability: () => undefined,
  recordBooking: () => undefined,
};
