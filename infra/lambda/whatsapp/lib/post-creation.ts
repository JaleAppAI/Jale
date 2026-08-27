/**
 * WhatsApp post-creation lane (spec: docs/superpowers/specs/2026-08-22-media-board-design.md).
 *
 * PURE module: talks to DB/Twilio/S3 only through the injected PostDeps —
 * never opens a transaction (no BEGIN/COMMIT), mirroring application-fill.ts.
 * The wiring task (processor.ts) constructs PostDeps from real Twilio/S3/DB
 * helpers and owns the transaction the caller's `client` participates in.
 *
 * Flow: idle --(photo)--> classify --(1=profile photo / 2=work board)-->
 * collecting --(text/"saltar")--> confirm --("publicar")--> published.
 * A "borrar"/"delete" keyword with no active draft offers to soft-delete
 * the worker's most recent published post (two-step confirm).
 */
import type { PoolClient } from 'pg';
import type { Lang } from './templates';
import type { InteractivePrompt } from './interactive-templates';
import { buildMediaInteractivePrompt } from './interactive-templates';
import { sniffPhotoType, detectMediaCategory } from './media';

export const POST_DRAFT_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_POST_PHOTOS = 10;
export const MAX_POST_PHOTO_BYTES = 10 * 1024 * 1024;

const PHOTO_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface PostDraft {
  post_id: string;
  stage: 'classify' | 'collecting' | 'confirm';
  media: {
    s3_key: string;
    s3_version_id: string | null;
    content_type: string;
    file_size: number;
    sort_order: number;
  }[];
  caption: string | null;
  started_at: string;
}

export interface PostDeps {
  queueReplyText(client: PoolClient, inboundSid: string, to: string, body: string): Promise<void>;
  queueInteractivePrompt(
    client: PoolClient,
    inboundSid: string,
    to: string,
    prompt: InteractivePrompt,
  ): Promise<void>;
  updateStateContext(
    client: PoolClient,
    conversationId: string,
    patch: Record<string, unknown>,
  ): Promise<void>;
  setRls(client: PoolClient, workerId: string): Promise<void>;
  downloadMedia(mediaUrl: string): Promise<Buffer>;
  uploadMedia(key: string, body: Buffer, contentType: string): Promise<string | null>;
  moderate(s3Key: string, versionId: string | null): Promise<'approved' | 'flagged'>;
  nowMs(): number;
  newId(): string;
}

export interface PostCtx {
  conversationId: string;
  workerId: string;
  lang: Lang;
  from: string;
  inboundSid: string;
  stateContext: Record<string, unknown>;
}

export type PostLaneMessage = {
  numMedia: number;
  mediaUrl?: string | null;
  mediaContentType?: string | null;
  body: string | null;
  buttonPayload?: string | null;
  interactivePayload?: string | null;
};

// ── Bilingual copy (module-local, like interactive-templates.ts) ────────
// RULE (spec §4): every message states the worker's next available actions.
const COPY = {
  collecting_intro: {
    es: (n: number) =>
      `¡Listo! Tengo ${n} foto${n === 1 ? '' : 's'} para tu tablero de trabajo (máx. 10).\n\n📷 Envía más fotos si quieres\n✍️ Envía un mensaje de texto para usarlo como descripción\n⏭️ O escribe "saltar" para publicar sin descripción`,
    en: (n: number) =>
      `Great! I have ${n} photo${n === 1 ? '' : 's'} for your work board (max 10).\n\n📷 Send more photos if you like\n✍️ Send a text message to use as the description\n⏭️ Or type "skip" to post without one`,
  },
  photo_count: {
    es: (n: number) => `📷 ${n}/10 fotos. Envía más, o escribe una descripción para continuar.`,
    en: (n: number) => `📷 ${n}/10 photos. Send more, or write a description to continue.`,
  },
  max_photos: {
    es: `Solo puedo incluir 10 fotos por publicación. Envía una descripción para continuar, o escribe "cancelar".`,
    en: `I can only include 10 photos per post. Send a description to continue, or type "cancel".`,
  },
  confirm_summary: {
    es: (n: number, caption: string | null) =>
      `Lista para publicar: ${n} foto${n === 1 ? '' : 's'}${caption ? `\nDescripción: "${caption}"` : '\nSin descripción'}\n\nLos empleadores con los que has aplicado la verán en tu perfil.\n\n✅ Escribe "publicar" para publicar\n✏️ Envía otro texto para cambiar la descripción\n⏭️ Escribe "saltar" para quitar la descripción\n❌ Escribe "cancelar" para descartar`,
    en: (n: number, caption: string | null) =>
      `Ready to publish: ${n} photo${n === 1 ? '' : 's'}${caption ? `\nDescription: "${caption}"` : '\nNo description'}\n\nEmployers you've applied with will see it on your profile.\n\n✅ Type "publish" to post\n✏️ Send different text to change the description\n⏭️ Type "skip" to remove the description\n❌ Type "cancel" to discard`,
  },
  published: {
    es: `✅ ¡Publicado en tu tablero de trabajo! Los empleadores ya pueden verlo en tu perfil.`,
    en: `✅ Posted to your work board! Employers can now see it on your profile.`,
  },
  published_flagged: {
    es: (n: number) =>
      `✅ ¡Publicado! Nota: ${n} foto${n === 1 ? ' quedó oculta' : 's quedaron ocultas'} en revisión y no ${n === 1 ? 'será visible' : 'serán visibles'} para empleadores.`,
    en: (n: number) =>
      `✅ Posted! Note: ${n} photo${n === 1 ? ' was' : 's were'} hidden pending review and won't be visible to employers.`,
  },
  cancelled: {
    es: `He descartado la publicación. Envíame fotos cuando quieras crear otra.`,
    en: `I've discarded the post. Send me photos anytime to create another.`,
  },
  discarded_for_command: {
    es: `(Descarté tu publicación sin terminar — envía las fotos de nuevo cuando quieras.)`,
    en: `(I've set aside your unfinished post — send the photos again anytime.)`,
  },
  expired: {
    es: `Tu publicación anterior expiró, así que empezamos de nuevo.`,
    en: `Your previous post draft expired, so we're starting fresh.`,
  },
  bad_photo: {
    es: `No pude usar ese archivo — solo acepto fotos JPG, PNG o WebP. Inténtalo con otra foto.`,
    en: `I couldn't use that file — I only accept JPG, PNG, or WebP photos. Try another photo.`,
  },
  profile_photo_saved: {
    es: `✅ ¡Guardada! Tu foto de perfil aparecerá en la app próximamente.`,
    en: `✅ Saved! Your profile photo will appear in the app soon.`,
  },
  profile_photo_multi: {
    es: (n: number) =>
      `Una foto de perfil es solo una foto y tengo ${n}. Responde 2 para publicarlas todas en tu tablero de trabajo, o "cancelar" para descartarlas.`,
    en: (n: number) =>
      `A profile photo is just one photo and I have ${n}. Reply 2 to post them all to your work board, or "cancel" to discard them.`,
  },
  classify_text_nudge: {
    es: `Recibí tu foto. Responde 1 para foto de perfil, 2 para tu tablero de trabajo, o "cancelar".`,
    en: `I got your photo. Reply 1 for profile photo, 2 for your work board, or "cancel".`,
  },
  delete_prompt: {
    es: (n: number, caption: string | null) =>
      `Tu última publicación: ${n} foto${n === 1 ? '' : 's'}${caption ? `\nDescripción: "${caption}"` : '\nSin descripción'}\n\nResponde "confirmar" para eliminarla o "cancelar".`,
    en: (n: number, caption: string | null) =>
      `Your latest post: ${n} photo${n === 1 ? '' : 's'}${caption ? `\nDescription: "${caption}"` : '\nNo description'}\n\nReply "confirm" to delete it or "cancel".`,
  },
  delete_done: {
    es: `🗑️ Publicación eliminada. Envía fotos cuando quieras crear otra.`,
    en: `🗑️ Post deleted. Send photos anytime to create another.`,
  },
  delete_none: {
    es: `No tienes publicaciones para eliminar. Envía fotos para crear tu primera publicación.`,
    en: `You don't have any posts to delete. Send photos to create your first post.`,
  },
  delete_cancelled: {
    es: `No eliminé nada. Envía fotos para crear una publicación, o escribe "borrar" para intentarlo de nuevo.`,
    en: `I didn't delete anything. Send photos to create a post, or type "delete" to try again.`,
  },
  expired_action: {
    es: `Eso ya expiró. Envía tus fotos de nuevo para empezar.`,
    en: `That expired. Send your photos again to start over.`,
  },
} as const;

const SKIP_WORDS = new Set(['saltar', 'skip']);
const CANCEL_WORDS = new Set(['cancelar', 'cancel']);
const PUBLISH_WORDS = new Set(['publicar', 'publish', 'post']);
const DELETE_WORDS = new Set(['borrar', 'delete']);
const CONFIRM_DELETE_WORDS = new Set(['confirmar', 'confirm']);

/**
 * Sanitizes free-text worker input before it becomes a post caption.
 * worker_posts.caption has `CHECK (char_length(caption) <= 1000)`
 * (migration 083_media_board.sql) — an unsanitized caption over that
 * length crashes publishDraft's INSERT with an uncaught constraint
 * violation. Global constraint (spec): max 1000 chars, trimmed, control
 * characters stripped. Order: strip control bytes, then trim, then
 * truncate — so trailing whitespace exposed by stripping doesn't survive
 * into the stored/displayed caption. Returns null if nothing is left,
 * so a control-chars-and-whitespace-only message is treated as "no
 * caption" rather than an empty-string caption.
 */
function sanitizeCaption(raw: string): string | null {
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 1000);
  return cleaned.length > 0 ? cleaned : null;
}

function normalize(body: string): string {
  // Escaped range (U+0300-U+036F, combining diacritical marks) rather than
  // literal combining characters pasted into source — those render
  // invisibly and are a landmine across editors/encodings.
  return body.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function getDraft(ctx: PostCtx): PostDraft | null {
  const d = ctx.stateContext.post_draft as PostDraft | null | undefined;
  return d ?? null;
}

async function setDraft(client: PoolClient, deps: PostDeps, ctx: PostCtx, draft: PostDraft | null): Promise<void> {
  await deps.updateStateContext(client, ctx.conversationId, { post_draft: draft });
}

export async function discardActiveDraft(client: PoolClient, deps: PostDeps, ctx: PostCtx): Promise<boolean> {
  const draft = getDraft(ctx);
  if (!draft) return false;
  await setDraft(client, deps, ctx, null);
  await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.discarded_for_command[ctx.lang]);
  return true;
}

/** Reply + persist the "collecting" copy for the work-board classification choice. */
async function doWorkSampleAction(client: PoolClient, deps: PostDeps, ctx: PostCtx, draft: PostDraft): Promise<void> {
  draft.stage = 'collecting';
  await setDraft(client, deps, ctx, draft);
  await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.collecting_intro[ctx.lang](draft.media.length));
}

/**
 * Profile photo classification. A profile photo is exactly one photo — if
 * the draft picked up more than one before the worker classified it, we
 * refuse (keeping the draft intact) and explain the work-board alternative
 * rather than silently discarding extra photos (Ivan, 2026-08-22).
 */
async function doProfilePhotoAction(client: PoolClient, deps: PostDeps, ctx: PostCtx, draft: PostDraft): Promise<void> {
  if (draft.media.length > 1) {
    await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.profile_photo_multi[ctx.lang](draft.media.length));
    return;
  }
  const first = draft.media[0];
  await deps.setRls(client, ctx.workerId);
  await client.query(
    `INSERT INTO worker_profile_media (user_id, media_type, s3_key, content_type)
     VALUES ($1, $2, $3, $4)`,
    [ctx.workerId, 'profile_photo', first.s3_key, first.content_type],
  );
  await setDraft(client, deps, ctx, null);
  await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.profile_photo_saved[ctx.lang]);
}

export async function handlePostLaneMessage(
  client: PoolClient,
  deps: PostDeps,
  ctx: PostCtx,
  msg: PostLaneMessage,
): Promise<{ handled: boolean }> {
  let draft = getDraft(ctx);

  // Expiry: discard stale draft, note it, and keep processing this message fresh.
  if (draft && deps.nowMs() - new Date(draft.started_at).getTime() > POST_DRAFT_TTL_MS) {
    await setDraft(client, deps, ctx, null);
    await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.expired[ctx.lang]);
    draft = null;
  }

  const payload = msg.buttonPayload ?? msg.interactivePayload ?? null;

  // 1) Classification buttons — only meaningful against a classify-stage
  // draft. A stale tap (draft already advanced/expired/gone) is claimed
  // with an "expired" reply rather than silently falling through.
  if (payload === 'media:photo_type:work_sample' || payload === 'media:photo_type:profile_photo') {
    if (draft && draft.stage === 'classify') {
      if (payload === 'media:photo_type:work_sample') {
        await doWorkSampleAction(client, deps, ctx, draft);
      } else {
        await doProfilePhotoAction(client, deps, ctx, draft);
      }
      return { handled: true };
    }
    await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.expired_action[ctx.lang]);
    return { handled: true };
  }

  // 2) Inbound photo: gate on category BEFORE downloading anything — a
  // voice note or other non-photo media is not this lane's concern at all.
  if (msg.numMedia > 0) {
    if (!msg.mediaUrl || detectMediaCategory(msg.mediaContentType ?? '') !== 'photo') {
      return { handled: false };
    }
    if (draft && draft.media.length >= MAX_POST_PHOTOS) {
      await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.max_photos[ctx.lang]);
      return { handled: true };
    }
    let buf: Buffer;
    try {
      buf = await deps.downloadMedia(msg.mediaUrl); // wired bounded to MAX_POST_PHOTO_BYTES
    } catch {
      await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.bad_photo[ctx.lang]);
      return { handled: true };
    }
    const mime = sniffPhotoType(buf);
    if (!mime) {
      // Sniff-fail is ALWAYS claimed now that the category gate above has
      // already ruled out non-photo media — an image-declared-but-not-a-
      // real-photo upload is squarely this lane's problem, draft or not.
      await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.bad_photo[ctx.lang]);
      return { handled: true };
    }
    const postId = draft?.post_id ?? deps.newId();
    const key = `${ctx.workerId}/posts/${postId}/${deps.newId()}.${PHOTO_MIME_TO_EXT[mime]}`;
    const versionId = await deps.uploadMedia(key, buf, mime);
    const item: PostDraft['media'][number] = {
      s3_key: key,
      s3_version_id: versionId,
      content_type: mime,
      file_size: buf.length,
      sort_order: draft?.media.length ?? 0,
    };

    if (!draft) {
      const fresh: PostDraft = {
        post_id: postId,
        stage: 'classify',
        media: [item],
        caption: msg.body ? sanitizeCaption(msg.body) : null,
        started_at: new Date(deps.nowMs()).toISOString(),
      };
      await setDraft(client, deps, ctx, fresh);
      // A fresh draft supersedes any half-finished "borrar" confirmation.
      if (ctx.stateContext.post_delete_pending != null) {
        await deps.updateStateContext(client, ctx.conversationId, { post_delete_pending: null });
      }
      await deps.queueInteractivePrompt(client, ctx.inboundSid, ctx.from, buildMediaInteractivePrompt('photo_type', ctx.lang));
      return { handled: true };
    }

    draft.media.push(item);
    if (draft.caption === null && msg.body) draft.caption = sanitizeCaption(msg.body);
    await setDraft(client, deps, ctx, draft);
    if (draft.stage === 'collecting') {
      await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.photo_count[ctx.lang](draft.media.length));
    } else if (draft.stage === 'confirm') {
      await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.confirm_summary[ctx.lang](draft.media.length, draft.caption));
    }
    // classify: silent append — the button/number prompt is already on screen.
    return { handled: true };
  }

  // 3) Text.
  if (msg.body !== null && msg.body.trim().length > 0) {
    const norm = normalize(msg.body);

    if (draft) {
      if (CANCEL_WORDS.has(norm)) {
        await setDraft(client, deps, ctx, null);
        await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.cancelled[ctx.lang]);
        return { handled: true };
      }
      if (draft.stage === 'classify') {
        if (norm === '1') {
          await doProfilePhotoAction(client, deps, ctx, draft);
          return { handled: true };
        }
        if (norm === '2') {
          await doWorkSampleAction(client, deps, ctx, draft);
          return { handled: true };
        }
        await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.classify_text_nudge[ctx.lang]);
        return { handled: true };
      }
      if (draft.stage === 'collecting') {
        draft.caption = SKIP_WORDS.has(norm) ? null : sanitizeCaption(msg.body);
        draft.stage = 'confirm';
        await setDraft(client, deps, ctx, draft);
        await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.confirm_summary[ctx.lang](draft.media.length, draft.caption));
        return { handled: true };
      }
      // confirm stage:
      if (PUBLISH_WORDS.has(norm)) {
        await publishDraft(client, deps, ctx, draft);
        return { handled: true };
      }
      draft.caption = SKIP_WORDS.has(norm) ? null : sanitizeCaption(msg.body);
      await setDraft(client, deps, ctx, draft);
      await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.confirm_summary[ctx.lang](draft.media.length, draft.caption));
      return { handled: true };
    }

    // No active draft — the delete-last-post flow lives here.
    const pending = ctx.stateContext.post_delete_pending as string | null | undefined;
    if (pending) {
      if (CONFIRM_DELETE_WORDS.has(norm)) {
        await deps.setRls(client, ctx.workerId);
        await client.query(
          `UPDATE worker_posts SET status = 'deleted' WHERE id = $1 AND worker_id = $2 AND status = 'published'`,
          [pending, ctx.workerId],
        );
        await deps.updateStateContext(client, ctx.conversationId, { post_delete_pending: null });
        await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.delete_done[ctx.lang]);
        return { handled: true };
      }
      await deps.updateStateContext(client, ctx.conversationId, { post_delete_pending: null });
      await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.delete_cancelled[ctx.lang]);
      return { handled: true };
    }

    if (CONFIRM_DELETE_WORDS.has(norm)) {
      // "confirmar" with nothing pending and no draft — a stale tap.
      await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.expired_action[ctx.lang]);
      return { handled: true };
    }

    if (DELETE_WORDS.has(norm)) {
      await deps.setRls(client, ctx.workerId);
      const res = await client.query(
        `SELECT id, caption, created_at,
                (SELECT count(*) FROM worker_post_media WHERE post_id = worker_posts.id) AS photo_count
         FROM worker_posts
         WHERE worker_id = $1 AND status = 'published'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [ctx.workerId],
      );
      const row = res.rows[0] as { id: string; caption: string | null; photo_count: number | string } | undefined;
      if (!row) {
        await deps.queueReplyText(client, ctx.inboundSid, ctx.from, COPY.delete_none[ctx.lang]);
        return { handled: true };
      }
      await deps.updateStateContext(client, ctx.conversationId, { post_delete_pending: row.id });
      await deps.queueReplyText(
        client,
        ctx.inboundSid,
        ctx.from,
        COPY.delete_prompt[ctx.lang](Number(row.photo_count), row.caption ?? null),
      );
      return { handled: true };
    }

    return { handled: false };
  }

  return { handled: false };
}

async function publishDraft(client: PoolClient, deps: PostDeps, ctx: PostCtx, draft: PostDraft): Promise<void> {
  const statuses = await Promise.all(draft.media.map((m) => deps.moderate(m.s3_key, m.s3_version_id)));
  await deps.setRls(client, ctx.workerId);
  await client.query(
    `INSERT INTO worker_posts (id, worker_id, caption, source, status)
     VALUES ($1, $2, $3, 'whatsapp', 'published')`,
    [draft.post_id, ctx.workerId, draft.caption],
  );
  for (let i = 0; i < draft.media.length; i++) {
    const m = draft.media[i];
    await client.query(
      `INSERT INTO worker_post_media (post_id, worker_id, s3_key, s3_version_id, sort_order, content_type, file_size, moderation_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [draft.post_id, ctx.workerId, m.s3_key, m.s3_version_id, m.sort_order, m.content_type, m.file_size, statuses[i]],
    );
  }
  await deps.updateStateContext(client, ctx.conversationId, { post_draft: null });
  const flagged = statuses.filter((s) => s === 'flagged').length;
  const body = flagged > 0 ? COPY.published_flagged[ctx.lang](flagged) : COPY.published[ctx.lang];
  await deps.queueReplyText(client, ctx.inboundSid, ctx.from, body);
}
