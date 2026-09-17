// The landing page's WhatsApp CTA link. Points at the /whatsapp redirect
// route (frontend/src/app/whatsapp/route.ts) rather than a hardcoded
// wa.me/<number> URL -- the business number lives only in
// WHATSAPP_BUSINESS_NUMBER (see that route) and must never be duplicated
// here.
//
// `?lang=en` tells the route to prefill "Jobs" instead of the Spanish
// default "Trabajos" -- see the route's own lang handling.
export function whatsappHref(locale: string): string {
  return locale === 'en' ? '/whatsapp?lang=en' : '/whatsapp';
}
