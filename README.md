# Backpack Bot

Automated wilderness reservation and backpacking permit booking for [recreation.gov](https://www.recreation.gov).

## What it does

1. **Browse permits** -- Fetches Oregon wilderness permit data from the RIDB API and displays them in a browsable list with entry points and zones.
2. **Check availability** -- Scrapes real-time availability from recreation.gov using Playwright, showing a color-coded calendar grid per entry point.
3. **Automated booking** -- Uses browser automation to sign in to recreation.gov and attempt to book a permit at a scheduled time (e.g., when the booking window opens).

## Tech stack

- **Frontend**: React 19, TypeScript 5.9, Vite 7, Tailwind CSS 4
- **Backend**: Node.js 24, Express 5, TypeScript
- **Browser automation**: Playwright (Chromium)
- **Monorepo**: npm workspaces

## Prerequisites

- Node.js 24+ (use `nvm use` to activate the correct version from `.nvmrc`)
- A **RIDB API key** -- register free at [ridb.recreation.gov](https://ridb.recreation.gov/)
- A **recreation.gov account** (for booking automation)

## Setup

```bash
# Install Node (if using nvm)
nvm install

# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Create your .env file
cp .env.example .env
# Edit .env and add your RIDB_API_KEY
```

## Development

```bash
# Start both server and client
npm run dev

# Or individually
npm run dev:server   # Express API on http://localhost:3001
npm run dev:client   # Vite dev server on http://localhost:5173
```

The client proxies `/api` requests to the server automatically.

## Usage

### Browsing permits

Open http://localhost:5173 and browse the list of Oregon wilderness permits. Click on a permit to see its entry points, zones, and links.

### Checking availability

On a permit detail page, click "Check Availability" to scrape real-time availability from recreation.gov. The calendar shows:

- **Green** -- Available
- **Yellow** -- Limited availability
- **Red** -- Unavailable
- **Blue** -- Walk-up only

### Booking a permit

1. Click on an available date in the calendar (or go to the Booking page directly)
2. Fill in the booking form with your desired permit, date, group size, and recreation.gov credentials
3. Optionally set a **scheduled start time** to have the bot begin attempting exactly when the booking window opens
4. Click "Start Booking Attempt"
5. Monitor the live status as the bot attempts to secure your permit

**Scheduling tip**: Central Cascades Wilderness permits in Oregon release ~40% on April 1st at 7:00 AM PDT, with the remaining 60% on a rolling 7-day window daily at 7:00 AM PDT. Set your scheduled start time to just before these windows open.

## Architecture

```
backpack-bot/
  packages/
    client/               React + Vite + Tailwind frontend
      src/
        components/       Shared UI components
        hooks/            React hooks for data fetching
        pages/            Route pages
        services/         API client
        types/            TypeScript types
    server/               Express + TypeScript backend
      src/
        routes/           API route handlers
        services/
          ridb.ts         RIDB API client (permit data)
          availability.ts Playwright availability scraper
          booking.ts      Playwright booking automation
        types/            Shared types
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/permits` | List Oregon permit facilities |
| GET | `/api/permits/:id` | Permit detail with entrances/zones |
| GET | `/api/permits/:id/availability?month=YYYY-MM` | Scrape availability |
| POST | `/api/booking` | Start a booking attempt |
| GET | `/api/booking/status` | Get all booking states |
| GET | `/api/booking/:id` | Get specific booking state |
| DELETE | `/api/booking/:id` | Cancel a booking attempt |
| GET | `/api/booking/events/stream` | SSE stream for live updates |

## Important notes

- Credentials are held **in memory only** and never persisted to disk
- The availability scraper launches a headless Chromium browser; first request may take 10-20 seconds
- Booking automation uses browser automation which may be affected by recreation.gov UI changes
- Be respectful of recreation.gov's servers -- the bot includes reasonable retry intervals (10s between attempts)
