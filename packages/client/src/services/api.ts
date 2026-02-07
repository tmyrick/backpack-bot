import type {
  PermitSummary,
  PermitDetail,
  PermitAvailability,
  BookingRequest,
  BookingState,
  SniperJob,
  SniperJobRequest,
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

// ---- Sniper ----

export async function createSniperJob(
  request: SniperJobRequest,
): Promise<SniperJob> {
  const data = await apiFetch<{ job: SniperJob }>("/sniper", {
    method: "POST",
    body: JSON.stringify(request),
  });
  return data.job;
}

export async function fetchSniperJobs(): Promise<SniperJob[]> {
  const data = await apiFetch<{ jobs: SniperJob[] }>("/sniper");
  return data.jobs;
}

export async function fetchSniperJob(
  id: string,
): Promise<{ job: SniperJob; needsCredentials: boolean }> {
  return apiFetch<{ job: SniperJob; needsCredentials: boolean }>(
    `/sniper/${id}`,
  );
}

export async function deleteSniperJob(
  id: string,
): Promise<{ deleted: boolean }> {
  return apiFetch<{ deleted: boolean }>(`/sniper/${id}`, {
    method: "DELETE",
  });
}

export async function supplySniperCredentials(
  id: string,
  email: string,
  password: string,
): Promise<{ updated: boolean }> {
  return apiFetch<{ updated: boolean }>(`/sniper/${id}/credentials`, {
    method: "PATCH",
    body: JSON.stringify({ email, password }),
  });
}
