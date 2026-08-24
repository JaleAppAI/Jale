import { PoolClient } from 'pg';
import {
  handlePostLaneMessage,
  discardActiveDraft,
  POST_DRAFT_TTL_MS,
  type PostDeps,
  type PostCtx,
  type PostDraft,
} from '../../../../../lambda/whatsapp/lib/post-creation';

const client = {} as PoolClient;
const NOW = 1_755_000_000_000;

function makeDeps(overrides: Partial<PostDeps> = {}): PostDeps & { sent: string[]; prompts: string[] } {
  const sent: string[] = [];
  const prompts: string[] = [];
  let idCounter = 0;
  return {
    sent,
    prompts,
    queueReplyText: jest.fn(async (_c, _sid, _to, body: string) => { sent.push(body); }),
    queueInteractivePrompt: jest.fn(async (_c, _sid, _to, prompt) => { prompts.push(prompt.templateName); }),
    updateStateContext: jest.fn(async (_c, _id, patch) => { Object.assign(ctxHolder.stateContext, patch); }),
    setRls: jest.fn(async () => {}),
    downloadMedia: jest.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0])), // jpeg magic
    uploadMedia: jest.fn(async () => 'v-1'),
    moderate: jest.fn(async () => 'approved' as const),
    nowMs: () => NOW,
    newId: jest.fn(() => `id-${++idCounter}`),
    ...overrides,
  };
}

const ctxHolder: PostCtx = {} as PostCtx;
function makeCtx(stateContext: Record<string, unknown> = {}): PostCtx {
  Object.assign(ctxHolder, {
    conversationId: 'conv-1',
    workerId: 'worker-1',
    lang: 'es' as const,
    from: 'whatsapp:+5210000000000',
    inboundSid: 'SM123',
    stateContext,
  });
  return ctxHolder;
}

const photoMsg = { numMedia: 1, mediaUrl: 'https://twilio/media/1', mediaContentType: 'image/jpeg', body: null };
const draft = (over: Partial<PostDraft> = {}): PostDraft => ({
  post_id: 'post-1', stage: 'collecting',
  media: [{ s3_key: 'worker-1/posts/post-1/a.jpg', s3_version_id: 'v-0', content_type: 'image/jpeg', file_size: 4, sort_order: 0 }],
  caption: null, started_at: new Date(NOW - 1000).toISOString(), ...over,
});

describe('post-creation lane', () => {
  let mockClient: PoolClient & { query: jest.Mock };
  beforeEach(() => {
    mockClient = { query: jest.fn(async () => ({ rows: [] })) } as unknown as PoolClient & { query: jest.Mock };
  });

  it('first photo at idle starts a classify draft and sends the photo_type prompt', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({});
    const res = await handlePostLaneMessage(mockClient, deps, ctx, photoMsg);
    expect(res.handled).toBe(true);
    expect(deps.uploadMedia).toHaveBeenCalledWith(
      expect.stringMatching(/^worker-1\/posts\/id-1\/id-2\.jpg$/),
      expect.any(Buffer),
      'image/jpeg',
    );
    const stored = ctx.stateContext.post_draft as PostDraft;
    expect(stored.stage).toBe('classify');
    expect(stored.media).toHaveLength(1);
    expect(stored.media[0].s3_version_id).toBe('v-1');
    expect(deps.prompts).toContain('onboarding_photo_type_es');
  });

  it('does not claim (and never downloads) non-photo media', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({});
    const res = await handlePostLaneMessage(mockClient, deps, ctx, {
      numMedia: 1, mediaUrl: 'https://twilio/media/2', mediaContentType: 'audio/ogg', body: null,
    });
    expect(res.handled).toBe(false);
    expect(deps.downloadMedia).not.toHaveBeenCalled();
  });

  it('photos during classify append silently (no extra prompt)', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft({ stage: 'classify' }) });
    await handlePostLaneMessage(mockClient, deps, ctx, photoMsg);
    const stored = ctx.stateContext.post_draft as PostDraft;
    expect(stored.media).toHaveLength(2);
    expect(deps.prompts).toHaveLength(0);
    expect(deps.sent).toHaveLength(0);
  });

  it("'2' at classify text moves to collecting like the work_sample button", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft({ stage: 'classify' }) });
    const res = await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: '2' });
    expect(res.handled).toBe(true);
    expect((ctx.stateContext.post_draft as PostDraft).stage).toBe('collecting');
  });

  it("'1' at classify text routes to the profile-photo action on a single-photo draft", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft({ stage: 'classify' }) });
    await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: '1' });
    const insert = mockClient.query.mock.calls.find(([sql]) => String(sql).includes('worker_profile_media'));
    expect(insert).toBeDefined();
    expect(ctx.stateContext.post_draft).toBeNull();
  });

  it('other text at classify nudges with the 1/2/cancelar options', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft({ stage: 'classify' }) });
    const res = await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: 'que es esto' });
    expect(res.handled).toBe(true);
    expect(deps.sent[0]).toMatch(/1/);
    expect(deps.sent[0]).toMatch(/2/);
    expect(deps.sent[0]).toMatch(/cancelar/i);
  });

  it('work_sample button moves classify → collecting with instructional copy', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft({ stage: 'classify' }) });
    const res = await handlePostLaneMessage(mockClient, deps, ctx, {
      numMedia: 0, body: null, buttonPayload: 'media:photo_type:work_sample',
    });
    expect(res.handled).toBe(true);
    expect((ctx.stateContext.post_draft as PostDraft).stage).toBe('collecting');
    expect(deps.sent[0]).toMatch(/foto/i); // bilingual copy mentions photos + description + 'saltar'
    expect(deps.sent[0]).toMatch(/saltar/i);
  });

  it('profile_photo button stores the single photo as profile media and clears the draft, with honest copy', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft({ stage: 'classify' }) });
    await handlePostLaneMessage(mockClient, deps, ctx, {
      numMedia: 0, body: null, buttonPayload: 'media:photo_type:profile_photo',
    });
    const insert = mockClient.query.mock.calls.find(([sql]) => String(sql).includes('worker_profile_media'));
    expect(insert?.[1]).toEqual(expect.arrayContaining(['worker-1', 'profile_photo']));
    expect(ctx.stateContext.post_draft).toBeNull();
    expect(deps.sent[0]).not.toMatch(/actualizada/i); // no false "updated" claim
    expect(deps.sent[0]).toMatch(/guardad|aparecer/i);
  });

  it('profile_photo action on a multi-photo draft refuses, explains, and keeps the draft', async () => {
    const deps = makeDeps();
    const media = [
      { s3_key: 'worker-1/posts/post-1/a.jpg', s3_version_id: 'v-0', content_type: 'image/jpeg', file_size: 4, sort_order: 0 },
      { s3_key: 'worker-1/posts/post-1/b.jpg', s3_version_id: 'v-0', content_type: 'image/jpeg', file_size: 4, sort_order: 1 },
    ];
    const ctx = makeCtx({ post_draft: draft({ stage: 'classify', media }) });
    const res = await handlePostLaneMessage(mockClient, deps, ctx, {
      numMedia: 0, body: null, buttonPayload: 'media:photo_type:profile_photo',
    });
    expect(res.handled).toBe(true);
    expect(mockClient.query.mock.calls.some(([sql]) => String(sql).includes('worker_profile_media'))).toBe(false);
    expect((ctx.stateContext.post_draft as PostDraft).media).toHaveLength(2);
    expect(deps.sent[0]).toMatch(/2/);
    expect(deps.sent[0]).toMatch(/perfil/i);
  });

  it('a media:photo_type tap with no matching classify draft says it expired', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({});
    const res = await handlePostLaneMessage(mockClient, deps, ctx, {
      numMedia: 0, body: null, buttonPayload: 'media:photo_type:work_sample',
    });
    expect(res.handled).toBe(true);
    expect(deps.sent[0]).toMatch(/expir/i);
  });

  it('photo during collecting appends and replies with a count', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft() });
    await handlePostLaneMessage(mockClient, deps, ctx, photoMsg);
    expect((ctx.stateContext.post_draft as PostDraft).media).toHaveLength(2);
    expect(deps.sent[0]).toContain('2/10');
  });

  it('the 11th photo is refused', async () => {
    const deps = makeDeps();
    const media = Array.from({ length: 10 }, (_, i) => ({
      s3_key: `worker-1/posts/post-1/${i}.jpg`, s3_version_id: 'v-0', content_type: 'image/jpeg', file_size: 4, sort_order: i,
    }));
    const ctx = makeCtx({ post_draft: draft({ media }) });
    await handlePostLaneMessage(mockClient, deps, ctx, photoMsg);
    expect((ctx.stateContext.post_draft as PostDraft).media).toHaveLength(10);
    expect(deps.uploadMedia).not.toHaveBeenCalled();
    expect(deps.sent[0]).toMatch(/10/);
  });

  it('first photo carries a caption from its accompanying text', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({});
    await handlePostLaneMessage(mockClient, deps, ctx, { ...photoMsg, body: 'techo terminado' });
    const stored = ctx.stateContext.post_draft as PostDraft;
    expect(stored.caption).toBe('techo terminado');
  });

  it('a photo sent with text while collecting (caption still null) stashes the caption', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft({ stage: 'collecting', caption: null }) });
    await handlePostLaneMessage(mockClient, deps, ctx, { ...photoMsg, body: 'segundo dia' });
    const stored = ctx.stateContext.post_draft as PostDraft;
    expect(stored.caption).toBe('segundo dia');
  });

  it('a photo sent at confirm stage re-shows the publish summary', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft({ stage: 'confirm', caption: 'x' }) });
    await handlePostLaneMessage(mockClient, deps, ctx, photoMsg);
    const stored = ctx.stateContext.post_draft as PostDraft;
    expect(stored.media).toHaveLength(2);
    expect(deps.sent[0]).toMatch(/publicar/i);
  });

  it('text during collecting becomes the caption and prompts confirm', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft() });
    await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: 'Instalación de tablaroca' });
    const stored = ctx.stateContext.post_draft as PostDraft;
    expect(stored.stage).toBe('confirm');
    expect(stored.caption).toBe('Instalación de tablaroca');
    expect(deps.sent[0]).toMatch(/publicar/i);
  });

  it('a caption over 1000 chars is truncated to exactly 1000 and still advances to confirm', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft() });
    const longCaption = 'a'.repeat(1500);
    await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: longCaption });
    const stored = ctx.stateContext.post_draft as PostDraft;
    expect(stored.stage).toBe('confirm');
    expect(stored.caption).toHaveLength(1000);
    expect(stored.caption).toBe('a'.repeat(1000));
  });

  it('control characters are stripped from the stored caption', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft() });
    await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: 'hola\x00\x1f mundo\x7f' });
    const stored = ctx.stateContext.post_draft as PostDraft;
    expect(stored.caption).toBe('hola mundo');
  });

  it('a caption of only control characters/whitespace is treated as no caption', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft() });
    const res = await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: '\x00\x1f   \x7f' });
    const stored = ctx.stateContext.post_draft as PostDraft;
    expect(res.handled).toBe(true);
    expect(stored.stage).toBe('confirm');
    expect(stored.caption).toBeNull();
    expect(deps.sent[0]).toMatch(/sin descripci/i);
  });

  it("'saltar' during collecting means no caption", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft() });
    await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: 'saltar' });
    const stored = ctx.stateContext.post_draft as PostDraft;
    expect(stored.stage).toBe('confirm');
    expect(stored.caption).toBeNull();
  });

  it("'saltar' at confirm clears the caption (not a literal caption) and re-shows the summary", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft({ stage: 'confirm', caption: 'algo' }) });
    await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: 'saltar' });
    const stored = ctx.stateContext.post_draft as PostDraft;
    expect(stored.caption).toBeNull();
    expect(stored.stage).toBe('confirm');
    expect(deps.sent[0]).toMatch(/publicar/i);
  });

  it("'publicar' at confirm publishes: moderates, inserts post + media, clears draft", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft({ stage: 'confirm', caption: 'mi trabajo' }) });
    await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: 'publicar' });
    expect(deps.moderate).toHaveBeenCalledWith('worker-1/posts/post-1/a.jpg', 'v-0');
    expect(deps.setRls).toHaveBeenCalledWith(mockClient, 'worker-1');
    const postInsert = mockClient.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO worker_posts'));
    expect(postInsert?.[1]).toEqual(['post-1', 'worker-1', 'mi trabajo']);
    const mediaInsert = mockClient.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO worker_post_media'));
    expect(mediaInsert).toBeDefined();
    expect(mediaInsert?.[1]).toEqual(expect.arrayContaining(['worker-1', 'v-0']));
    expect(ctx.stateContext.post_draft).toBeNull();
    expect(deps.sent[0]).toMatch(/publicad/i);
  });

  it('publish mentions hidden photos when some are flagged', async () => {
    const deps = makeDeps({ moderate: jest.fn(async () => 'flagged' as const) });
    const ctx = makeCtx({ post_draft: draft({ stage: 'confirm' }) });
    await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: 'publicar' });
    expect(deps.sent[0]).toMatch(/revisión/i);
  });

  it("'cancelar' at any stage discards the draft", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft() });
    await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: 'cancelar' });
    expect(ctx.stateContext.post_draft).toBeNull();
    expect(mockClient.query.mock.calls.some(([sql]) => String(sql).includes('INSERT'))).toBe(false);
  });

  it('text at confirm that is not a keyword replaces the caption and re-prompts', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft({ stage: 'confirm', caption: 'old' }) });
    await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: 'nueva descripción' });
    const stored = ctx.stateContext.post_draft as PostDraft;
    expect(stored.caption).toBe('nueva descripción');
    expect(stored.stage).toBe('confirm');
  });

  it('an expired draft is discarded and the message is processed fresh', async () => {
    const deps = makeDeps();
    const stale = draft({ started_at: new Date(NOW - POST_DRAFT_TTL_MS - 1).toISOString() });
    const ctx = makeCtx({ post_draft: stale });
    const res = await handlePostLaneMessage(mockClient, deps, ctx, photoMsg);
    // Stale draft discarded; the photo starts a NEW classify draft.
    expect(res.handled).toBe(true);
    const stored = ctx.stateContext.post_draft as PostDraft;
    expect(stored.post_id).not.toBe('post-1');
    expect(stored.stage).toBe('classify');
  });

  it('a photo that fails the magic-byte sniff is ALWAYS rejected with copy, even with no draft', async () => {
    const deps = makeDeps({ downloadMedia: jest.fn(async () => Buffer.from('%PDF-1.4')) });
    const ctx = makeCtx({});
    const res = await handlePostLaneMessage(mockClient, deps, ctx, photoMsg);
    expect(res.handled).toBe(true);
    expect(ctx.stateContext.post_draft).toBeUndefined();
    expect(deps.uploadMedia).not.toHaveBeenCalled();
    expect(deps.sent[0]).toMatch(/JPG|PNG|WebP/i);
  });

  it('a photo that fails the sniff during an active draft is rejected without touching the draft', async () => {
    const deps = makeDeps({ downloadMedia: jest.fn(async () => Buffer.from('%PDF-1.4')) });
    const ctx = makeCtx({ post_draft: draft() });
    const res = await handlePostLaneMessage(mockClient, deps, ctx, photoMsg);
    expect(res.handled).toBe(true);
    expect(deps.uploadMedia).not.toHaveBeenCalled();
    expect((ctx.stateContext.post_draft as PostDraft).media).toHaveLength(1);
    expect(deps.sent[0]).toMatch(/JPG|PNG|WebP/i);
  });

  it('non-lane messages are not handled (no draft, no photo)', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({});
    const res = await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: 'hola' });
    expect(res.handled).toBe(false);
  });

  it('discardActiveDraft clears the draft and notifies', async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ post_draft: draft() });
    const had = await discardActiveDraft(mockClient, deps, ctx);
    expect(had).toBe(true);
    expect(ctx.stateContext.post_draft).toBeNull();
    expect(deps.sent[0].length).toBeGreaterThan(0);
    expect(await discardActiveDraft(mockClient, deps, makeCtx({}))).toBe(false);
  });

  describe('delete-last-post flow', () => {
    it("'borrar' with no draft prompts confirm for the latest post", async () => {
      mockClient.query.mockImplementation(async (sql: string) =>
        String(sql).includes('SELECT id, caption') ? { rows: [{ id: 'post-9', caption: 'x', created_at: '2026-08-20T00:00:00Z', photo_count: 3 }] } : { rows: [] });
      const deps = makeDeps();
      const ctx = makeCtx({});
      const res = await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: 'borrar' });
      expect(res.handled).toBe(true);
      expect(ctx.stateContext.post_delete_pending).toBe('post-9');
      expect(deps.sent[0]).toMatch(/confirmar/i);
    });

    it("'confirmar' soft-deletes the pending post", async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ post_delete_pending: 'post-9' });
      await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: 'confirmar' });
      const upd = mockClient.query.mock.calls.find(([sql]) => String(sql).includes(`SET status = 'deleted'`));
      expect(upd?.[1]).toEqual(['post-9', 'worker-1']);
      expect(ctx.stateContext.post_delete_pending).toBeNull();
    });

    it("'borrar' with no posts replies nothing-to-delete", async () => {
      const deps = makeDeps();
      const ctx = makeCtx({});
      const res = await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: 'borrar' });
      expect(res.handled).toBe(true);
      expect(ctx.stateContext.post_delete_pending).toBeUndefined();
    });

    it('anything other than confirmar clears a pending delete', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ post_delete_pending: 'post-9' });
      const res = await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: 'espera no' });
      expect(res.handled).toBe(true);
      expect(ctx.stateContext.post_delete_pending).toBeNull();
      expect(mockClient.query.mock.calls.some(([sql]) => String(sql).includes(`SET status = 'deleted'`))).toBe(false);
    });

    it("'confirmar' with no draft or pending delete says it expired, never unhandled", async () => {
      const deps = makeDeps();
      const ctx = makeCtx({});
      const res = await handlePostLaneMessage(mockClient, deps, ctx, { numMedia: 0, body: 'confirmar' });
      expect(res.handled).toBe(true);
      expect(deps.sent[0]).toMatch(/expir/i);
    });
  });
});
