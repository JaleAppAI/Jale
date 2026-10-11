/**
 * How to reach the team when the in-app report form cannot be used: reporting
 * is paused, a send failed, or the app could not load at all.
 *
 * Both values already exist elsewhere, and this is not a place to add a new
 * one: `email` is the support address the legal pages publish
 * (`app/privacypolicy/route.ts`, `app/terms/route.ts`), and `whatsappKeyword`
 * is the word the WhatsApp support flow answers. The test beside this file
 * reads both sources.
 */
export const SUPPORT_CONTACT = {
    email: 'support@jaleapp.ai',
    whatsappKeyword: 'soporte',
} as const;
