export const PHONE_COUNTRY_CODES = [
  { value: '+1', label: 'US +1' },
  { value: '+52', label: 'MX +52' },
] as const;

export type PhoneCountryCode = (typeof PHONE_COUNTRY_CODES)[number]['value'];

const DEFAULT_COUNTRY_CODE: PhoneCountryCode = '+1';

export function splitPhoneNumber(phone: string): { countryCode: PhoneCountryCode; localNumber: string } {
  const trimmed = phone.trim();
  const matched = PHONE_COUNTRY_CODES.find((option) => trimmed.startsWith(option.value));
  if (!matched) return { countryCode: DEFAULT_COUNTRY_CODE, localNumber: trimmed.replace(/^\+/, '') };

  return {
    countryCode: matched.value,
    localNumber: trimmed.slice(matched.value.length).trim(),
  };
}

export function formatPhoneNumber(countryCode: PhoneCountryCode, localNumber: string): string {
  const digits = localNumber.replace(/[^\d]/g, '');
  return digits ? `${countryCode}${digits}` : '';
}
