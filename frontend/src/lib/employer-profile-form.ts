export type EmployerSignupField =
  | 'company_name'
  | 'contact_name'
  | 'email'
  | 'password'
  | 'password_confirm'
  | 'phone'
  | 'city'
  | 'service_area'
  | 'hiring_trades'
  | 'typical_job_types';

export type EmployerProfileField =
  | 'company_name'
  | 'contact_name'
  | 'phone'
  | 'city'
  | 'service_area'
  | 'hiring_trades'
  | 'typical_job_types';

export interface EmployerSignupFieldValues {
  company_name: string;
  contact_name: string;
  email: string;
  password: string;
  password_confirm: string;
  phone: string;
  city: string;
  service_area: string;
  hiring_trades: string[];
  typical_job_types: string[];
}

export interface EmployerProfileFieldValues {
  company_name: string;
  contact_name: string;
  phone: string;
  city: string;
  service_area: string;
  hiring_trades: string[];
  typical_job_types: string[];
}

export function validateEmployerSignupFields(values: EmployerSignupFieldValues): EmployerSignupField[] {
  const missing: EmployerSignupField[] = [];
  if (!values.company_name.trim()) missing.push('company_name');
  if (!values.contact_name.trim()) missing.push('contact_name');
  if (!values.email.trim()) missing.push('email');
  if (!values.password) missing.push('password');
  if (!values.password_confirm) missing.push('password_confirm');
  if (!values.phone.trim()) missing.push('phone');
  if (!values.city.trim()) missing.push('city');
  if (!values.service_area.trim()) missing.push('service_area');
  if (values.hiring_trades.length === 0) missing.push('hiring_trades');
  if (values.typical_job_types.length === 0) missing.push('typical_job_types');
  return missing;
}

export function validateEmployerProfileFields(values: EmployerProfileFieldValues): EmployerProfileField[] {
  const missing: EmployerProfileField[] = [];
  if (!values.company_name.trim()) missing.push('company_name');
  if (!values.contact_name.trim()) missing.push('contact_name');
  if (!values.phone.trim()) missing.push('phone');
  if (!values.city.trim()) missing.push('city');
  if (!values.service_area.trim()) missing.push('service_area');
  if (values.hiring_trades.length === 0) missing.push('hiring_trades');
  if (values.typical_job_types.length === 0) missing.push('typical_job_types');
  return missing;
}
