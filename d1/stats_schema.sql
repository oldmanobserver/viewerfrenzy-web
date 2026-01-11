-- ViewerFrenzy - D1 schema for competition stats
--
-- Create a D1 database (suggested binding name: VF_D1_STATS) and apply this schema.
--
-- Notes:
-- - Times are stored as UTC milliseconds since epoch.
-- - competition_uuid is client-generated (GUID) and provides idempotency.
-- - Results are upserted by (competition_id, viewer_user_id).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  competition_uuid TEXT NOT NULL UNIQUE,

  streamer_user_id TEXT NOT NULL,
  streamer_login TEXT,

  season_id TEXT,

  map_id TEXT,
  map_name TEXT,
  map_version INTEGER,
  map_hash_sha256 TEXT,

  vehicle_type TEXT,
  game_mode TEXT,
  race_seed INTEGER,

  track_length_m REAL,

  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER NOT NULL,

  winner_user_id TEXT,

  client_version TEXT,
  unity_version TEXT,

  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_competitions_streamer ON competitions(streamer_user_id, started_at_ms);
CREATE INDEX IF NOT EXISTS idx_competitions_season ON competitions(season_id, started_at_ms);

CREATE TABLE IF NOT EXISTS competition_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  competition_id INTEGER NOT NULL,
  viewer_user_id TEXT NOT NULL,

  viewer_login TEXT,
  viewer_display_name TEXT,
  viewer_profile_image_url TEXT,

  finish_position INTEGER,
  status TEXT NOT NULL,
  finish_time_ms INTEGER,

  vehicle_id TEXT,
  distance_m REAL,
  progress01 REAL,

  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,

  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
  UNIQUE (competition_id, viewer_user_id)
);

CREATE INDEX IF NOT EXISTS idx_results_competition ON competition_results(competition_id, finish_position);
CREATE INDEX IF NOT EXISTS idx_results_viewer ON competition_results(viewer_user_id, competition_id);
