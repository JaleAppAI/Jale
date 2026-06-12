# Worker OTP SMS Runbook

Worker OTPs for both web login and WhatsApp onboarding are sent through the
Twilio Messages API from the dedicated number configured by
`otpSmsFromNumber`. OTPs must never use the WhatsApp sender or Messaging
Service.

## Deployment checks

1. Confirm `otpSmsFromNumber` is attached to the approved A2P campaign.
2. Confirm `jale/whatsapp/otp-twilio` contains `accountSid` and `authToken`.
3. Restrict Twilio SMS Geo Permissions to the countries Jale supports.
4. Enable Twilio SMS Pumping Protection and account usage/spend alerts.
5. Deploy `NetworkStack` and `AuthStack`, then run a worker web and WhatsApp
   onboarding smoke test.
6. Confirm the `WorkerOtpSendErrors` CloudWatch alarm is in `OK`.

## Runtime behavior

- The Twilio request aborts after `otpSmsRequestTimeoutMs` (default 3500 ms),
  below Cognito's fixed five-second trigger deadline.
- `otpSmsValidityPeriodSeconds` (default 180 seconds) prevents an OTP from
  remaining in Twilio's queue after it is useful.
- Existing worker signup requests return success without changing Cognito or
  profile data. Profile changes require a completed OTP-authenticated session.
- Twilio HTTP success means queued, not delivered.

## Alerts and investigation

Investigate `WorkerOtpSendErrors` immediately because worker authentication may
be unavailable. Check Lambda errors, Twilio Messaging logs, campaign status,
sender assignment, Geo Permissions, and account balance without exposing OTPs
or credentials in tickets or logs.

## Open production control

The Cognito custom-auth entry point is public and does not expose a reliable
client IP to `CreateAuthChallenge`. Before high-volume public launch, add a
durable per-phone issuance cooldown with retry-safe OTP idempotency, place an
edge control in front of authentication, or migrate OTP issuance to Twilio
Verify with Fraud Guard. Do not use WhatsApp as an OTP fallback.
