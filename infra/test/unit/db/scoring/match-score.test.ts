describe('match_score() V1 scaffold', () => {
  test.todo('perfect match: same trade, senior, overlapping skills, <5mi, 10yr exp scores above 80');
  test.todo('trade mismatch is hard-filtered and produces no score');
  test.todo('good partial match: same trade, mid-level, 3 overlapping skills, 10mi scores 45-69');
  test.todo('distance beyond radius is filtered before candidate materialization');
  test.todo('new worker with trade match but no skills/trust signals receives a non-zero cold-start floor');
});
