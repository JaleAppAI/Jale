import {
  toEmployerCandidateView,
  toWorkerJobView,
} from '../../../../lambda/lib/candidate-views';

const baseInternal = {
  workerId: 'worker-1',
  jobId: 'job-1',
  score: 70,
  scoreComponents: { skill_overlap: 18 },
  candidateRank: 1,
  workerLatitude: 39.961176,
  workerLongitude: -82.998794,
  distanceMeters: 8046.7,
};

describe('candidate view mappers', () => {
  it('strips exact matching and location data from employer candidate views', () => {
    const view = toEmployerCandidateView(
      baseInternal,
      'Maria G.',
      'Columbus, OH area',
      ['carpentry'],
      ['Trade match'],
    );

    expect(view).toEqual({
      workerId: 'worker-1',
      displayName: 'Maria G.',
      metroArea: 'Columbus, OH area',
      distanceBand: '5-15mi',
      skills: ['carpentry'],
      scoreBand: 'strong',
      fitReasons: ['Trade match'],
    });
    expect(view).not.toHaveProperty('workerLatitude');
    expect(view).not.toHaveProperty('workerLongitude');
    expect(view).not.toHaveProperty('distanceMeters');
    expect(view).not.toHaveProperty('score');
    expect(view).not.toHaveProperty('scoreComponents');
  });

  it('maps distance bands at the 5mi and 15mi boundaries', () => {
    expect(toEmployerCandidateView({ ...baseInternal, distanceMeters: 8046.69 }, 'A B.', 'Area', [], []).distanceBand).toBe('<5mi');
    expect(toEmployerCandidateView({ ...baseInternal, distanceMeters: 8046.7 }, 'A B.', 'Area', [], []).distanceBand).toBe('5-15mi');
    expect(toEmployerCandidateView({ ...baseInternal, distanceMeters: 24140.1 }, 'A B.', 'Area', [], []).distanceBand).toBe('5-15mi');
    expect(toEmployerCandidateView({ ...baseInternal, distanceMeters: 24140.11 }, 'A B.', 'Area', [], []).distanceBand).toBe('>15mi');
  });

  it('maps score bands at the 70 and 45 thresholds', () => {
    expect(toEmployerCandidateView({ ...baseInternal, score: 70 }, 'A B.', 'Area', [], []).scoreBand).toBe('strong');
    expect(toEmployerCandidateView({ ...baseInternal, score: 69 }, 'A B.', 'Area', [], []).scoreBand).toBe('good');
    expect(toEmployerCandidateView({ ...baseInternal, score: 45 }, 'A B.', 'Area', [], []).scoreBand).toBe('good');
    expect(toEmployerCandidateView({ ...baseInternal, score: 44 }, 'A B.', 'Area', [], []).scoreBand).toBe('fair');
  });

  it('maps worker-facing job views without candidate internals', () => {
    const view = toWorkerJobView(
      {
        id: 'job-1',
        title: 'Concrete Finisher',
        company: 'Acme',
        location: 'Columbus, OH',
        job_type: 'contract',
        pay: '$25/hr',
      },
      ['Close by'],
    );

    expect(view).toEqual({
      jobId: 'job-1',
      title: 'Concrete Finisher',
      company: 'Acme',
      jobSiteArea: 'Columbus, OH',
      jobType: 'contract',
      pay: '$25/hr',
      fitReasons: ['Close by'],
    });
  });
});
