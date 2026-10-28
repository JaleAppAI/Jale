import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/**
 * Every Phase 3 (team management) string, pinned in both catalogues.
 *
 * PINNED is the plan's table, verbatim. ADDED is the copy the real backend
 * contract needs beyond it: a message for every error code a Phase 3 screen
 * can meet, and the few labels the Team, invite and access screens use.
 * `messages-parity.test.ts` covers en/es key parity; this pins the text, and
 * formats every entry through next-intl's real translator so a broken ICU
 * plural fails here rather than on screen.
 */

type MessageNode = string | { [key: string]: MessageNode };
type Row = readonly [path: string, en: string, es: string];

function resolve(tree: MessageNode, path: string): string | undefined {
    let node: MessageNode = tree;
    for (const segment of path.split('.')) {
        if (typeof node === 'string' || !(segment in node)) return undefined;
        node = node[segment];
    }
    return typeof node === 'string' ? node : undefined;
}

const PINNED: readonly Row[] = [
    ["employer_dashboard.nav.team", "Team", "Equipo"],
    ["employer_team.title", "Team", "Equipo"],
    ["employer_team.seats", "{used} of {limit} foreman seats used", "{used} de {limit} puestos de capataz en uso"],
    ["employer_team.seats_pending", "{count, plural, one {# pending invite} other {# pending invites}}", "{count, plural, one {# invitación pendiente} other {# invitaciones pendientes}}"],
    ["employer_team.no_seats", "Your plan has no foreman seats. Upgrade to invite foremen.", "Su plan no incluye puestos de capataz. Mejore su plan para invitar capataces."],
    ["employer_team.invite.title", "Invite a foreman", "Invitar a un capataz"],
    ["employer_team.invite.email", "Email", "Correo electrónico"],
    ["employer_team.invite.name", "Name (optional)", "Nombre (opcional)"],
    ["employer_team.invite.submit", "Send invite", "Enviar invitación"],
    ["employer_team.invite.sent", "Invite sent to {email}.", "Invitación enviada a {email}."],
    ["employer_team.errors.email_in_use", "This email already has a Jale employer account with another company.", "Este correo ya tiene una cuenta de empleador en Jale con otra empresa."],
    ["employer_team.errors.already_member", "This person is already on your team.", "Esta persona ya forma parte de su equipo."],
    ["employer_team.errors.invite_pending", "There's already a pending invite for this email. Resend it instead.", "Ya hay una invitación pendiente para este correo. Reenvíela."],
    ["employer_team.errors.seat_limit_reached", "All your foreman seats are in use.", "Todos sus puestos de capataz están en uso."],
    ["employer_team.errors.invite_rate_limited", "Too many invites right now. Try again later.", "Demasiadas invitaciones por ahora. Inténtelo más tarde."],
    ["employer_team.errors.invalid_email", "Enter a valid email address.", "Ingrese un correo electrónico válido."],
    ["employer_team.errors.generic", "Something went wrong. Try again.", "Algo salió mal. Inténtelo de nuevo."],
    ["employer_team.pending.title", "Pending invites", "Invitaciones pendientes"],
    ["employer_team.pending.expires", "Expires {date}", "Vence el {date}"],
    ["employer_team.pending.expired", "Expired", "Vencida"],
    ["employer_team.pending.resend", "Resend", "Reenviar"],
    ["employer_team.pending.revoke", "Revoke", "Revocar"],
    ["employer_team.members.title", "Members", "Miembros"],
    ["employer_team.members.owner", "Owner", "Propietario"],
    ["employer_team.members.foreman", "Foreman", "Capataz"],
    ["employer_team.members.suspended", "Suspended", "Suspendido"],
    ["employer_team.members.jobs", "{count, plural, one {# open job} other {# open jobs}}", "{count, plural, one {# empleo abierto} other {# empleos abiertos}}"],
    ["employer_team.members.remove", "Remove", "Quitar"],
    ["employer_team.remove.title", "Remove {name}?", "¿Quitar a {name}?"],
    ["employer_team.remove.body", "Their jobs and conversations move to the person you choose. They can't sign in afterwards.", "Sus empleos y conversaciones pasarán a la persona que elija. Después no podrá iniciar sesión."],
    ["employer_team.remove.reassign_label", "Move their jobs to", "Pasar sus empleos a"],
    ["employer_team.remove.confirm", "Remove and move jobs", "Quitar y pasar empleos"],
    ["employer_team.remove.cancel", "Cancel", "Cancelar"],
    ["employer_team.remove.done", "{name} was removed. {count, plural, one {# job moved.} other {# jobs moved.}}", "Se quitó a {name}. {count, plural, one {Se pasó # empleo.} other {Se pasaron # empleos.}}"],
    ["employer_team.reassign.label", "Responsible", "Responsable"],
    ["employer_team.reassign.save", "Change", "Cambiar"],
    ["employer_team.reassign.done", "This job is now {name}'s.", "Este empleo ahora es de {name}."],
    ["employer_access.no_organization.title", "Your invite expired", "Su invitación venció"],
    ["employer_access.no_organization.body", "Your invite expired, ask your company to resend it.", "Su invitación venció; pida a su empresa que se la reenvíe."],
    ["employer_access.no_organization.start_title", "Or start your own company", "O cree su propia empresa"],
    ["employer_access.no_organization.start_name", "Company name", "Nombre de la empresa"],
    ["employer_access.no_organization.start_submit", "Start my company", "Crear mi empresa"],
    ["employer_access.suspended.title", "Your access is paused", "Su acceso está en pausa"],
    ["employer_access.suspended.body", "Your company's plan has no seat for you right now. Ask your company's owner.", "El plan de su empresa no tiene un puesto para usted en este momento. Consulte con el propietario de su empresa."],
    ["employer_access.removed.title", "You're no longer on this team", "Ya no forma parte de este equipo"],
    ["employer_access.removed.body", "Your company removed you from its team on Jale. Ask the owner to invite you again.", "Su empresa lo quitó de su equipo en Jale. Pida al propietario que lo vuelva a invitar."],
    ["employer_access.removed.has_invite", "You have a new invite from your company. Open the link in your invite email to rejoin.", "Tiene una nueva invitación de su empresa. Abra el enlace de su correo de invitación para unirse de nuevo."],
    ["employer_access.sign_out", "Sign out", "Cerrar sesión"],
    ["auth.employer.invite.title", "Join {companyName} on Jale", "Únase a {companyName} en Jale"],
    ["auth.employer.invite.body", "{companyName} invited you as a foreman. Create your account with {email}.", "{companyName} lo invitó como capataz. Cree su cuenta con {email}."],
    ["auth.employer.invite.rejoin_body", "{companyName} invited you back. Sign in with {email} to rejoin.", "{companyName} lo volvió a invitar. Inicie sesión con {email} para unirse de nuevo."],
    ["auth.employer.invite.rejoin_submit", "Sign in and join", "Iniciar sesión y unirse"],
    ["auth.employer.invite.not_found", "This invite link isn't valid. Ask your company for a new one.", "Este enlace de invitación no es válido. Pida uno nuevo a su empresa."],
    ["auth.employer.invite.expired", "Your invite expired, ask your company to resend it.", "Su invitación venció; pida a su empresa que se la reenvíe."],
    ["auth.employer.invite.revoked", "This invite was cancelled. Ask your company for a new one.", "Esta invitación fue cancelada. Pida una nueva a su empresa."],
    ["auth.employer.invite.used", "This invite was already used. Sign in instead.", "Esta invitación ya se usó. Inicie sesión."],
    ["auth.employer.invite.email_mismatch", "Sign in with the email this invite was sent to.", "Inicie sesión con el correo al que se envió esta invitación."],
    ["auth.employer.invite.already_member", "This account already belongs to a company on Jale, so it can't join another one.", "Esta cuenta ya pertenece a una empresa en Jale, así que no puede unirse a otra."],
    ["auth.employer.invite.employer_required", "Sign in with a Jale employer account to accept this invite.", "Inicie sesión con una cuenta de empleador de Jale para aceptar esta invitación."],
    ["auth.employer.account_disabled", "This account can't sign in. If your company removed you, ask the owner to invite you again.", "Esta cuenta no puede iniciar sesión. Si su empresa lo quitó, pida al propietario que lo vuelva a invitar."],
    ["billing.limit_dialog.foreman_body", "Your company has reached its plan limit — ask your owner to upgrade.", "Su empresa alcanzó el límite de su plan; pida al propietario que lo mejore."],
    ["billing.limit_dialog.pro_owner_hint", "You're on the highest plan. Pause or close a job, or delete a template, to free a slot.", "Ya tiene el plan más alto. Pause o cierre un empleo, o elimine una plantilla, para liberar un espacio."],
    ["billing.company.suspended_body_pro", "{count, plural, one {# foreman is suspended and can't} other {# foremen are suspended and can't}} use your company's account because every seat is taken. Remove them on the Team page or contact Jale support.", "{count, plural, one {# capataz está suspendido y no puede} other {# capataces están suspendidos y no pueden}} usar la cuenta de su empresa porque todos los puestos están ocupados. Quítelos en la página Equipo o contacte al soporte de Jale."],
    ["billing.company.seats", "Foreman seats: {used} of {limit} used", "Puestos de capataz: {used} de {limit} en uso"],
];

const ADDED: readonly Row[] = [
    ["employer_team.no_seats_link", "See plans", "Ver planes"],
    ["employer_team.errors.invalid_contact_name", "That name is too long. Use 120 characters or fewer.", "Ese nombre es demasiado largo. Use 120 caracteres o menos."],
    ["employer_team.errors.invite_closed", "This invite is no longer pending. The list is now up to date.", "Esta invitación ya no está pendiente. La lista ya está actualizada."],
    ["employer_team.errors.invite_not_found", "We couldn't find that invite. The list is now up to date.", "No encontramos esa invitación. La lista ya está actualizada."],
    ["employer_team.errors.member_not_found", "We couldn't find that team member. Refresh the page and try again.", "No encontramos a ese miembro del equipo. Actualice la página e inténtelo de nuevo."],
    ["employer_team.errors.member_has_jobs", "This foreman still has jobs. Choose who takes them over and try again.", "Este capataz todavía tiene empleos. Elija quién se hará cargo de ellos e inténtelo de nuevo."],
    ["employer_team.errors.already_removed", "This foreman was already removed. Refresh the page.", "Este capataz ya fue quitado del equipo. Actualice la página."],
    ["employer_team.errors.cannot_remove_owner", "The owner can't be removed from the team.", "El propietario no se puede quitar del equipo."],
    ["employer_team.errors.invalid_assignee", "That person can't take these jobs right now. Refresh the page and choose someone else.", "Esa persona no puede hacerse cargo de estos empleos en este momento. Actualice la página y elija a otra persona."],
    ["employer_team.errors.job_not_found", "We couldn't find this job. Refresh the page.", "No encontramos este empleo. Actualice la página."],
    ["employer_team.errors.owner_required", "Only your company's owner can manage the team.", "Solo el propietario de su empresa puede administrar el equipo."],
    ["employer_team.errors.employer_required", "Sign in with a Jale employer account to manage a team.", "Inicie sesión con una cuenta de empleador de Jale para administrar un equipo."],
    ["employer_team.errors.busy", "We're handling other changes right now. Wait a moment and try again.", "Estamos procesando otros cambios en este momento. Espere un momento e inténtelo de nuevo."],
    ["employer_team.errors.job_move_conflict", "This job was reassigned — refresh the page to continue.", "Este empleo fue reasignado; actualice la página para continuar."],
    ["employer_team.pending.empty", "No pending invites.", "No hay invitaciones pendientes."],
    ["employer_team.pending.resent", "Invite resent to {email}.", "Invitación reenviada a {email}."],
    ["employer_team.pending.revoked", "Invite revoked.", "Invitación revocada."],
    ["employer_team.members.you", "You", "Usted"],
    ["employer_access.errors.invalid_company_name", "Enter your company's name (up to 120 characters).", "Ingrese el nombre de su empresa (hasta 120 caracteres)."],
    ["employer_access.errors.busy", "We're handling other changes right now. Wait a moment and try again.", "Estamos procesando otros cambios en este momento. Espere un momento e inténtelo de nuevo."],
    ["employer_access.errors.generic", "Something went wrong. Try again.", "Algo salió mal. Inténtelo de nuevo."],
    ["auth.employer.invite.busy", "We're handling other changes right now. Wait a moment and try again.", "Estamos procesando otros cambios en este momento. Espere un momento e inténtelo de nuevo."],
    ["auth.employer.invite.generic", "Something went wrong. Try again.", "Algo salió mal. Inténtelo de nuevo."],
    ["employer.profile.foreman_company_hint", "Only your company's owner can change these.", "Solo el propietario de su empresa puede cambiar estos datos."],
];

/** The copy pass after Milestone C (Task 17b): strings the screens had borrowed. */
const FOLLOW_UP: readonly Row[] = [
    ["billing.limit_dialog.body_templates_no_upgrade", "Your plan allows {limit, plural, one {# saved template} other {# saved templates}}. Delete one to save this one.", "Su plan permite {limit, plural, one {# plantilla guardada} other {# plantillas guardadas}}. Elimine una para guardar esta."],
    ["auth.employer.invite.join_signed_in_body", "You're signed in. Join {companyName} with this account?", "Ya inició sesión. ¿Desea unirse a {companyName} con esta cuenta?"],
    ["auth.employer.invite.join_submit", "Join {companyName}", "Unirse a {companyName}"],
    ["auth.employer.invite.use_another_account", "Use another account", "Usar otra cuenta"],
    ["auth.employer.invite.used_signed_in", "This invite was already used.", "Esta invitación ya se usó."],
    ["auth.employer.invite.account_disabled", "This account can't sign in yet. If your invite just arrived, wait a minute and try again; otherwise ask your company to resend it.", "Esta cuenta todavía no puede iniciar sesión. Si su invitación acaba de llegar, espere un minuto e inténtelo de nuevo; si no, pida a su empresa que se la reenvíe."],
    ["billing.limit_dialog.body_templates_foreman", "Your company's plan allows {limit, plural, one {# saved template} other {# saved templates}}. Delete one you created, or ask your owner to free a slot.", "El plan de su empresa permite {limit, plural, one {# plantilla guardada} other {# plantillas guardadas}}. Elimine una que usted creó o pida al propietario que libere un espacio."],
    ["billing.limit_dialog.foreman_body_pro", "Your company is using all of its active job slots. Pause or close one of your jobs, or ask your owner to free a slot.", "Su empresa está usando todos sus espacios de empleos activos. Pause o cierre uno de sus empleos, o pida al propietario que libere un espacio."],
    ["employer_dashboard.templates.delete_forbidden", "You can only delete templates you created.", "Solo puede eliminar las plantillas que usted creó."],
];

type CreateTranslatorOptions = Parameters<typeof createTranslator>[0];
type Values = Record<string, string | number>;

function format(locale: 'en' | 'es', path: string, values: Values): { text: string; errors: string[] } {
    const errors: string[] = [];
    const t = createTranslator({
        locale,
        messages: locale === 'en' ? en : es,
        onError: (error: Error) => errors.push(error.message),
    } as unknown as CreateTranslatorOptions) as unknown as (key: string, values?: Values) => string;
    return { text: t(path, values), errors };
}

const SAMPLE_VALUES: Values = {
    used: 2, limit: 3, count: 1, email: 'ana@example.com', date: 'Oct 27', name: 'Ana', companyName: 'Acme',
};

describe('Phase 3 i18n keys', () => {
    it.each(PINNED)('%s is pinned in en and es', (path, enText, esText) => {
        expect(resolve(en as MessageNode, path)).toBe(enText);
        expect(resolve(es as MessageNode, path)).toBe(esText);
    });

    it.each(ADDED)('%s (contract fold-in) is pinned in en and es', (path, enText, esText) => {
        expect(resolve(en as MessageNode, path)).toBe(enText);
        expect(resolve(es as MessageNode, path)).toBe(esText);
    });

    it.each(FOLLOW_UP)('%s (copy pass) is pinned in en and es', (path, enText, esText) => {
        expect(resolve(en as MessageNode, path)).toBe(enText);
        expect(resolve(es as MessageNode, path)).toBe(esText);
    });

    it.each([...PINNED, ...ADDED, ...FOLLOW_UP])('%s formats without an ICU error in both locales', (path) => {
        for (const locale of ['en', 'es'] as const) {
            const { text, errors } = format(locale, path, SAMPLE_VALUES);
            expect(errors).toEqual([]);
            expect(text.trim().length).toBeGreaterThan(0);
            expect(text).not.toContain('{');
        }
    });

    it('counted copy agrees with its number at one and at more than one', () => {
        expect(format('en', 'employer_team.seats_pending', { count: 1 }).text).toBe('1 pending invite');
        expect(format('es', 'employer_team.seats_pending', { count: 2 }).text).toBe('2 invitaciones pendientes');
        expect(format('en', 'employer_team.remove.done', { name: 'Ana', count: 1 }).text).toBe('Ana was removed. 1 job moved.');
        expect(format('es', 'employer_team.remove.done', { name: 'Ana', count: 3 }).text).toBe('Se quitó a Ana. Se pasaron 3 empleos.');
        expect(format('es', 'billing.company.suspended_body_pro', { count: 2 }).text)
            .toMatch(/^2 capataces están suspendidos y no pueden usar/);
    });

    it('the Spanish seat and foreman vocabulary is "puestos de capataz" and "capataz/capataces"', () => {
        expect(resolve(es as MessageNode, 'employer_team.seats')).toContain('puestos de capataz');
        expect(resolve(es as MessageNode, 'billing.company.seats')).toContain('Puestos de capataz');
        expect(resolve(es as MessageNode, 'employer_team.members.foreman')).toBe('Capataz');
        expect(resolve(es as MessageNode, 'employer_team.no_seats')).toContain('capataces');
    });

    it('the Pro owner\'s suspended remedy is removing members, not changing plan', () => {
        const body = resolve(en as MessageNode, 'billing.company.suspended_body_pro') ?? '';
        expect(body).toContain('Remove them on the Team page');
        expect(body).not.toMatch(/change your plan/i);
    });
});
