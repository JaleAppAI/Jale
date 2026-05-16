'use client';

import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { PHONE_COUNTRY_CODES, type PhoneCountryCode } from '@/lib/phone';

export function PhoneNumberField({
  countryCode,
  localNumber,
  onCountryCodeChange,
  onLocalNumberChange,
  placeholder = '(555) 000-0000',
  autoComplete = 'tel-national',
}: {
  countryCode: PhoneCountryCode;
  localNumber: string;
  onCountryCodeChange: (value: PhoneCountryCode) => void;
  onLocalNumberChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2">
      <Select
        value={countryCode}
        onChange={(e) => onCountryCodeChange(e.target.value as PhoneCountryCode)}
        aria-label="Country code"
      >
        {PHONE_COUNTRY_CODES.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </Select>
      <Input
        type="tel"
        placeholder={placeholder}
        value={localNumber}
        onChange={(e) => onLocalNumberChange(e.target.value)}
        inputMode="tel"
        autoComplete={autoComplete}
      />
    </div>
  );
}
