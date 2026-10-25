-- Wayfinder schema (PostgreSQL + PostGIS). Loaded by docker-compose on first start.
--
-- Canonical locations are WGS-84 (SRID 4326). Provider-specific identifiers are
-- kept in destination_provider_refs. Provider content (names, reviews, hours)
-- may only be stored where that provider's terms allow it, so the canonical
-- record holds our own or openly licensed data and refs hold provider IDs.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE travellers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email       text UNIQUE NOT NULL,
    display_name text,
    home_currency char(3) NOT NULL DEFAULT 'SGD',
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Structured preferences produced by the AI from natural-language requests,
-- plus per-traveller scoring weights calibrated from feedback.
CREATE TABLE preferences (
    traveller_id uuid PRIMARY KEY REFERENCES travellers(id) ON DELETE CASCADE,
    interests    text[] NOT NULL DEFAULT '{}',
    pace         text NOT NULL DEFAULT 'moderate' CHECK (pace IN ('relaxed', 'moderate', 'packed')),
    max_walk_min int,
    dietary      text[] NOT NULL DEFAULT '{}',
    score_weights jsonb NOT NULL DEFAULT '{}',
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE destinations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name_en         text NOT NULL,
    name_local      text,
    country_code    char(2) NOT NULL,
    city            text NOT NULL,
    categories      text[] NOT NULL DEFAULT '{}',
    tags            text[] NOT NULL DEFAULT '{}',
    location        geography(Point, 4326) NOT NULL,
    address_en      text,
    address_local   text,
    -- [{"dow": 0-6, "opens": "09:00", "closes": "17:00"}, ...]
    opening_hours   jsonb,
    visit_min       int,
    typical_cost    numeric(10, 2),
    cost_currency   char(3),
    accessibility   jsonb,
    source          text NOT NULL,
    last_verified_at timestamptz,
    -- 0..1. Verified provider data scores higher than an old manual entry.
    confidence      real NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX destinations_location_idx ON destinations USING gist (location);
CREATE INDEX destinations_city_idx ON destinations (country_code, city);

CREATE TABLE destination_provider_refs (
    destination_id    uuid NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
    provider          text NOT NULL CHECK (provider IN ('google', 'amap', 'baidu')),
    provider_place_id text NOT NULL,
    fetched_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (destination_id, provider),
    UNIQUE (provider, provider_place_id)
);

CREATE TABLE trips (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id     uuid NOT NULL REFERENCES travellers(id) ON DELETE CASCADE,
    title        text NOT NULL,
    start_date   date NOT NULL,
    end_date     date NOT NULL CHECK (end_date >= start_date),
    travellers   int NOT NULL DEFAULT 1 CHECK (travellers > 0),
    budget       numeric(12, 2),
    budget_currency char(3),
    brief        text,  -- the original natural-language request
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trip_days (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id     uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    day_date    date NOT NULL,
    country_code char(2) NOT NULL,
    city        text NOT NULL,
    base_location geography(Point, 4326),  -- usually the hotel
    mode        text NOT NULL DEFAULT 'transit' CHECK (mode IN ('walking', 'driving', 'transit')),
    day_start   time NOT NULL DEFAULT '09:00',
    day_end     time NOT NULL DEFAULT '21:00',
    UNIQUE (trip_id, day_date)
);

CREATE TABLE itinerary_items (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_day_id   uuid NOT NULL REFERENCES trip_days(id) ON DELETE CASCADE,
    destination_id uuid NOT NULL REFERENCES destinations(id),
    position      int NOT NULL,
    planned_arrive time,
    planned_depart time,
    visit_min     int,
    mandatory     boolean NOT NULL DEFAULT false,
    notes         text,
    UNIQUE (trip_day_id, position) DEFERRABLE INITIALLY DEFERRED
);

-- Feedback loop for recommendation weights: saved, removed, visited, rated.
CREATE TABLE recommendation_feedback (
    id             bigserial PRIMARY KEY,
    traveller_id   uuid NOT NULL REFERENCES travellers(id) ON DELETE CASCADE,
    destination_id uuid NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
    event          text NOT NULL CHECK (event IN ('saved', 'removed', 'visited', 'rated')),
    rating         smallint CHECK (rating BETWEEN 1 AND 5),
    created_at     timestamptz NOT NULL DEFAULT now()
);
