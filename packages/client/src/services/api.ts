import type {
  PermitSummary,
  PermitDetail,
  PermitAvailability,
  BookingRequest,
  BookingState,
} from "../types/index.js";

const API_BASE = "/api";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ---- Permits ----

export async function fetchPermits(): Promise<PermitSummary[]> {
  const data = await apiFetch<{ permits: PermitSummary[] }>("/permits");
  return data.permits;
}

export async function fetchPermitDetail(
  permitId: string,
): Promise<PermitDetail> {
  const data = await apiFetch<{ permit: PermitDetail }>(
    `/permits/${permitId}`,
  );
  return data.permit;
}

// ---- Availability ----

export async function fetchAvailability(
  permitId: string,
  month: string,
): Promise<PermitAvailability> {
  const data = await apiFetch<{ availability: PermitAvailability }>(
    `/permits/${permitId}/availability?month=${month}`,
  );
  return data.availability;
}

// ---- Booking ----

export async function createBooking(
  request: BookingRequest,
): Promise<BookingState> {
  const data = await apiFetch<{ booking: BookingState }>("/booking", {
    method: "POST",
    body: JSON.stringify(request),
  });
  return data.booking;
}

export async function fetchBookingStatus(): Promise<BookingState[]> {
  const data = await apiFetch<{ bookings: BookingState[] }>("/booking/status");
  return data.bookings;
}

export async function cancelBooking(
  bookingId: string,
): Promise<{ cancelled: boolean }> {
  return apiFetch<{ cancelled: boolean }>(`/booking/${bookingId}`, {
    method: "DELETE",
  });
}
