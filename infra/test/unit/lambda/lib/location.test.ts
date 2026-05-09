import { setJobCoordinates, setWorkerCoordinates } from '../../../../lambda/lib/location';

const mockQuery = jest.fn();
const client = { query: mockQuery } as any;

describe('location helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rowCount: 1 });
  });

  it('uses confidence precedence so geocoded_zip cannot overwrite a fresh map_pin', async () => {
    await setWorkerCoordinates(client, 'worker-1', 39.961176, -82.998794, 'geocoded_zip');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('$5 >= location_confidence');
    expect(sql).toContain("location_updated_at < NOW() - INTERVAL '7 days'");
    expect(sql).toContain('location_updated_at IS NULL');
    expect(params).toEqual(['worker-1', 39.961176, -82.998794, 'geocoded_zip', 30]);
  });

  it('assigns map_pin the highest confidence', async () => {
    await setWorkerCoordinates(client, 'worker-1', 39.961176, -82.998794, 'map_pin');

    expect(mockQuery.mock.calls[0][1]).toEqual(['worker-1', 39.961176, -82.998794, 'map_pin', 100]);
  });

  it('does not let fresh geocoded jobs overwrite manual coordinates', async () => {
    await setJobCoordinates(client, 'job-1', 39.961176, -82.998794, 'geocoded');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("$4 = 'manual'");
    expect(sql).toContain("location_source <> 'manual'");
    expect(sql).toContain("location_updated_at < NOW() - INTERVAL '7 days'");
    expect(params).toEqual(['job-1', 39.961176, -82.998794, 'geocoded']);
  });

  it('rejects coordinates outside valid ranges', async () => {
    await expect(setWorkerCoordinates(client, 'worker-1', 91, -82.998794, 'map_pin')).rejects.toThrow('invalid_latitude');
    await expect(setJobCoordinates(client, 'job-1', 39.961176, -181, 'manual')).rejects.toThrow('invalid_longitude');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
