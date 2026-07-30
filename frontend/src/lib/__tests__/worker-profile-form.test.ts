import { describe, expect, it } from 'vitest';
import { validateWorkerProfileFields } from '@/lib/worker-profile-form';

describe('validateWorkerProfileFields', () => {
  it('returns all fields for a fully empty profile', () => {
    const missing = validateWorkerProfileFields({ full_name: '', skills: [], availability: '', location: '' });
    expect(missing).toEqual(['full_name', 'skills', 'availability', 'location']);
  });

  it('returns no fields for a complete profile', () => {
    const missing = validateWorkerProfileFields({
      full_name: 'Ivan Armenta',
      skills: ['drywall'],
      availability: 'full_time',
      location: 'El Paso, TX',
    });
    expect(missing).toEqual([]);
  });

  it('flags only the missing fields for a partial profile', () => {
    const missing = validateWorkerProfileFields({
      full_name: 'Ivan Armenta',
      skills: [],
      availability: 'full_time',
      location: '',
    });
    expect(missing).toEqual(['skills', 'location']);
  });

  it('treats whitespace-only strings as missing', () => {
    const missing = validateWorkerProfileFields({
      full_name: '   ',
      skills: ['drywall'],
      availability: 'full_time',
      location: '   ',
    });
    expect(missing).toEqual(['full_name', 'location']);
  });
});
