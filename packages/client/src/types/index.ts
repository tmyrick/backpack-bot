// ---- Permit Types (mirrors server types) ----

export interface PermitSummary {
  facilityId: string;
  name: string;
  description: string;
  latitude: number;
  longitude: number;
  reservable: boolean;
  links: { title: string; url: string }[];
  entranceCount: number;
}

export interface PermitDetail extends PermitSummary {
  entrances: PermitEntrance[];
}

export interface PermitEntrance {
  id: string;
  name: string;
  description: string;
  district: string;
  town: string;
  latitude: number;
  longitude: number;
  zones: PermitZone[];
}

export interface PermitZone {
  id: string;
  name: string;
  description: string;
}

// ---- Availability Types ----

export interface DayAvailability {
  date: string;
  remaining: number;
  total: number;
  status: "available" | "limited" | "unavailable" | "walk-up" | "unknown";
}

export interface EntranceAvailability {
  entranceId: string;
  entranceName: string;
  days: DayAvailability[];
}

export interface PermitAvailability {
  permitId: string;
  month: string;
  entrances: EntranceAvailability[];
}

// ---- Booking Types ----

export type BookingStatus =
  | "idle"
  | "scheduled"
  | "waiting"
  | "attempting"
  | "in-cart"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface BookingRequest {
  permitId: string;
  entranceId: string;
  date: string;
  groupSize: number;
  email: string;
  password: string;
  startAt?: string;
  headless?: boolean;
}

export interface BookingState {
  id: string;
  status: BookingStatus;
  permitId: string;
  entranceId: string;
  date: string;
  groupSize: number;
  startAt: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  message: string;
  createdAt: string;
}
