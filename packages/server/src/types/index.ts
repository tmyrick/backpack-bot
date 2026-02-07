// ---- RIDB API Types ----

export interface RIDBFacility {
  FacilityID: string;
  FacilityName: string;
  FacilityDescription: string;
  FacilityTypeDescription: string;
  FacilityUseFeeDescription: string;
  FacilityDirections: string;
  FacilityPhone: string;
  FacilityEmail: string;
  FacilityLatitude: number;
  FacilityLongitude: number;
  Keywords: string;
  Reservable: boolean;
  Enabled: boolean;
  LastUpdatedDate: string;
  ACTIVITY: RIDBActivity[];
  LINK: RIDBLink[];
  PERMITENTRANCE: RIDBPermitEntrance[];
}

export interface RIDBActivity {
  ActivityID: number;
  ActivityName: string;
  FacilityActivityDescription: string;
  FacilityActivityFeeDescription: string;
}

export interface RIDBLink {
  EntityLinkID: string;
  LinkType: string;
  EntityID: string;
  EntityType: string;
  Title: string;
  Description: string;
  URL: string;
}

export interface RIDBPermitEntrance {
  PermitEntranceID: string;
  FacilityID: string;
  PermitEntranceName: string;
  PermitEntranceDescription: string;
  District: string;
  Town: string;
  PermitEntranceAccessible: boolean;
  Latitude: number;
  Longitude: number;
  CreatedDate: string;
  LastUpdatedDate: string;
  ATTRIBUTES: RIDBAttribute[];
  ZONES: RIDBZone[];
}

export interface RIDBZone {
  ZoneID: string;
  ZoneName: string;
  ZoneDescription: string;
  FacilityID: string;
  PermitEntranceID: string;
}

export interface RIDBAttribute {
  AttributeID: number;
  AttributeName: string;
  AttributeValue: string;
}

export interface RIDBPaginatedResponse<T> {
  RECDATA: T[];
  METADATA: {
    RESULTS: {
      CURRENT_COUNT: number;
      TOTAL_COUNT: number;
    };
    SEARCH_PARAMETERS: {
      QUERY: string;
      LIMIT: number;
      OFFSET: number;
    };
  };
}

// ---- App Types ----

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
  date: string; // YYYY-MM-DD
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
  month: string; // YYYY-MM
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
  date: string; // YYYY-MM-DD
  groupSize: number;
  email: string;
  password: string;
  startAt?: string; // ISO timestamp to begin attempting
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
