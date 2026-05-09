import type { PoolClient } from 'pg';

export type WorkerLocationSource = 'map_pin' | 'geocoded_address' | 'geocoded_zip';
export type JobLocationSource = 'manual' | 'geocoded';

const SOURCE_CONFIDENCE: Record<WorkerLocationSource, number> = {
  map_pin: 100,
  geocoded_address: 70,
  geocoded_zip: 30,
};

function assertCoordinates(lat: number, lon: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error('invalid_latitude');
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error('invalid_longitude');
  }
}

export async function setWorkerCoordinates(
  client: PoolClient,
  workerId: string,
  lat: number,
  lon: number,
  source: WorkerLocationSource,
): Promise<void> {
  assertCoordinates(lat, lon);
  const confidence = SOURCE_CONFIDENCE[source];

  await client.query(`
    UPDATE worker_profiles SET
      latitude = $2,
      longitude = $3,
      location_source = $4,
      location_confidence = $5,
      location_updated_at = NOW()
    WHERE user_id = $1
      AND (
        location_confidence IS NULL
        OR $5 >= location_confidence
        OR location_updated_at IS NULL
        OR location_updated_at < NOW() - INTERVAL '7 days'
      )
  `, [workerId, lat, lon, source, confidence]);
}

export async function setJobCoordinates(
  client: PoolClient,
  jobId: string,
  lat: number,
  lon: number,
  source: JobLocationSource,
): Promise<void> {
  assertCoordinates(lat, lon);

  await client.query(`
    UPDATE jobs SET
      latitude = $2,
      longitude = $3,
      location_source = $4,
      location_updated_at = NOW()
    WHERE id = $1
      AND (
        location_source IS NULL
        OR $4 = 'manual'
        OR location_source <> 'manual'
        OR location_updated_at IS NULL
        OR location_updated_at < NOW() - INTERVAL '7 days'
      )
  `, [jobId, lat, lon, source]);
}

export async function geocodeAddress(_address: string): Promise<{ lat: number; lon: number } | null> {
  return null;
}
