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

// ---- Campground Types ----

export interface CampgroundSummary {
  facilityId: string;
  name: string;
  description: string;
  latitude: number;
  longitude: number;
  reservable: boolean;
  links: { title: string; url: string }[];
  campsiteCount: number;
  isPermitFacility: boolean;
}

export interface CampsiteSummary {
  campsiteId: string;
  campsiteName: string;
  campsiteType: string;
  loop: string;
  maxPeople: number;
  minPeople: number;
  typeOfUse: string;
}

// ---- Sniper Types ----

export type BookingType = "permit" | "campsite";

export type SniperStatus =
  | "pending"
  | "pre-warming"
  | "watching"
  | "booking"
  | "in-cart"
  | "failed"
  | "cancelled";

export interface DateRange {
  startDate: string; // YYYY-MM-DD (entry date)
  endDate: string;   // YYYY-MM-DD (exit date)
}

export interface SniperJob {
  id: string;
  bookingType: BookingType;
  // Permit fields
  permitId: string;
  permitName: string;
  divisionId: string;
  // Campsite fields
  campgroundId: string;
  campgroundName: string;
  campgroundIsPermit: boolean;
  campsiteId: string;
  bookedCampsiteId: string;
  // Common fields
  desiredDateRanges: DateRange[];
  groupSize: number;
  windowOpensAt: string;
  status: SniperStatus;
  attempts: number;
  message: string;
  bookedRange: DateRange | null;
  createdAt: string;
  updatedAt: string;
}

export interface SniperJobRequest {
  bookingType: BookingType;
  // Permit fields
  permitId?: string;
  permitName?: string;
  divisionId?: string;
  // Campsite fields
  campgroundId?: string;
  campgroundName?: string;
  campgroundIsPermit?: boolean;
  campsiteId?: string;
  // Common fields
  desiredDateRanges: DateRange[];
  groupSize: number;
  windowOpensAt: string;
}
