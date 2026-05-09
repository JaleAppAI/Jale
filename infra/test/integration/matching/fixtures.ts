export interface MatchingFixture {
  employerId: string;
  jobId: string;
  workerId: string;
}

export async function createMatchingFixture(): Promise<MatchingFixture> {
  throw new Error('Matching integration fixtures are implemented with V1 routes/processors.');
}

export async function teardownMatchingFixture(_fixture: MatchingFixture): Promise<void> {
  throw new Error('Matching integration fixtures are implemented with V1 routes/processors.');
}
