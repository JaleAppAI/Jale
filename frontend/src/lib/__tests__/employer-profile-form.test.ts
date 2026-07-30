import { describe, expect, it } from 'vitest';
import { validateEmployerSignupFields, validateEmployerProfileFields } from '@/lib/employer-profile-form';

describe('validateEmployerSignupFields', () => {
  const complete = {
    company_name: 'Test Co',
    contact_name: 'Ivan',
    email: 'ivan@test.com',
    password: 'password123!',
    password_confirm: 'password123!',
    phone: '+15125550123',
    city: 'El Paso',
    service_area: 'El Paso metro',
    hiring_trades: ['electrician'],
    typical_job_types: ['full-time'],
  };

  it('returns all fields for a fully empty signup', () => {
    const missing = validateEmployerSignupFields({
      company_name: '', contact_name: '', email: '', password: '', password_confirm: '',
      phone: '', city: '', service_area: '', hiring_trades: [], typical_job_types: [],
    });
    expect(missing).toEqual([
      'company_name', 'contact_name', 'email', 'password', 'password_confirm',
      'phone', 'city', 'service_area', 'hiring_trades', 'typical_job_types',
    ]);
  });

  it('returns no fields for a complete signup', () => {
    expect(validateEmployerSignupFields(complete)).toEqual([]);
  });

  it('flags only the missing fields', () => {
    const missing = validateEmployerSignupFields({ ...complete, city: '', hiring_trades: [] });
    expect(missing).toEqual(['city', 'hiring_trades']);
  });
});

describe('validateEmployerProfileFields', () => {
  const complete = {
    company_name: 'Test Co',
    contact_name: 'Ivan',
    phone: '+15125550123',
    city: 'El Paso',
    service_area: 'El Paso metro',
    hiring_trades: ['electrician'],
    typical_job_types: ['full-time'],
  };

  it('returns no fields for a complete profile', () => {
    expect(validateEmployerProfileFields(complete)).toEqual([]);
  });

  it('flags only the missing fields', () => {
    const missing = validateEmployerProfileFields({ ...complete, service_area: '', typical_job_types: [] });
    expect(missing).toEqual(['service_area', 'typical_job_types']);
  });
});
