describe('matching idempotency contracts', () => {
  test.todo('processing the same SQS materialization message twice produces exactly one job_candidates row');
  test.todo('duplicate worker_job_impressions rows with the same worker/job/window key are rejected');
  test.todo('worker_match_log retries use deterministic event_key values and cannot duplicate outcome rows');
  test.todo('duplicate candidate ranks for the same job are rejected by job_candidates_job_rank_unique');
});
