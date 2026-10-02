import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
} from 'vitest'

// Shared, hoisted state the module mocks close over. Reset per test.
const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  state: {
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    priorCustomerMsgCount: 0,
    replyContextParent: null as { id: string } | null,

    conversation: {
      id: 'conv-1',
      unread_count: 0,
      account_id: 'acc-1',
      whatsapp_config_id: 'cfg-1',
    },

    upsertCalls: [] as {
      row: Record<string, unknown>
      options: unknown
    }[],

    rpcCalls: [] as {
      name: string
      args: Record<string, unknown>
    }[],

    afterCallbacks: [] as (() => Promise<void> | void)[],

    automationStarted: 0,
    automationCompleted: 0,

    mirrorInboundMedia: true as boolean | undefined,

    storageUploads: [] as {
      bucket: string
      path: string
      options: { contentType?: string }
    }[],

    storageUploadError:
      null as { message: string } | null,
  },
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb)
  },

  NextResponse: {
    json: (
      body: unknown,
      init?: { status?: number },
    ) => ({
      body,
      init,
    }),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      switch (table) {
        case 'whatsapp_config': {
          const data = {
            id: 'cfg-1',
            account_id: 'acc-1',
            user_id: 'user-1',
            business_portfolio_id: 'portfolio-1',
            waba_id: 'waba-1',
            phone_number_id: 'pn-1',
            access_token: 'enc',
            mirror_inbound_media:
              h.state.mirrorInboundMedia,
          }

          const chain: Record<string, unknown> = {
            eq: () => chain,
            in: () => chain,
            order: () => chain,

            limit: () =>
              Promise.resolve({
                data: [data],
                error: null,
              }),

            maybeSingle: () =>
              Promise.resolve({
                data,
                error: null,
              }),

            single: () =>
              Promise.resolve({
                data,
                error: null,
              }),

            // IMPORTANTE:
            // O route.ts faz await diretamente nessa query,
            // portanto o resultado precisa ser um array.
            then: (
              onFulfilled?: (
                value: {
                  data: typeof data[]
                  error: null
                },
              ) => unknown,
              onRejected?: (
                reason: unknown,
              ) => unknown,
            ) =>
              Promise.resolve({
                data: [data],
                error: null,
              }).then(
                onFulfilled,
                onRejected,
              ),
          }

          return {
            select: () => chain,
          }
        }

        case 'conversations': {
          const chain: Record<string, unknown> = {
            eq: () => chain,
            in: () => chain,
            order: () => chain,

            limit: () =>
              Promise.resolve({
                data: [
                  h.state.conversation,
                ],
                error: null,
              }),

            maybeSingle: () =>
              Promise.resolve({
                data: h.state.conversation,
                error: null,
              }),

            single: () =>
              Promise.resolve({
                data: h.state.conversation,
                error: null,
              }),

            then: (
              onFulfilled?: (
                value: {
                  data: typeof h.state.conversation[]
                  error: null
                },
              ) => unknown,
              onRejected?: (
                reason: unknown,
              ) => unknown,
            ) =>
              Promise.resolve({
                data: [
                  h.state.conversation,
                ],
                error: null,
              }).then(
                onFulfilled,
                onRejected,
              ),
          }

          return {
            select: () => chain,
          }
        }

        case 'broadcast_recipients': {
          const chain: Record<string, unknown> = {
            eq: () => chain,
            in: () => chain,
            order: () => chain,

            limit: () =>
              Promise.resolve({
                data: [],
                error: null,
              }),

            maybeSingle: () =>
              Promise.resolve({
                data: null,
                error: null,
              }),

            single: () =>
              Promise.resolve({
                data: null,
                error: null,
              }),

            then: (
              onFulfilled?: (
                value: {
                  data: never[]
                  error: null
                },
              ) => unknown,
              onRejected?: (
                reason: unknown,
              ) => unknown,
            ) =>
              Promise.resolve({
                data: [],
                error: null,
              }).then(
                onFulfilled,
                onRejected,
              ),
          }

          return {
            select: () => chain,
          }
        }

        case 'messages':
          return {
            select: (
              _columns: string,
              options?: { head?: boolean },
            ) => {
              if (options?.head) {
                const chain: Record<
                  string,
                  unknown
                > = {
                  eq: () => chain,
                  in: () => chain,
                  order: () => chain,
                  limit: () => chain,

                  maybeSingle: () =>
                    Promise.resolve({
                      data: null,
                      error: null,
                    }),

                  then: (
                    onFulfilled?: (
                      value: {
                        count: number
                        error: null
                      },
                    ) => unknown,
                    onRejected?: (
                      reason: unknown,
                    ) => unknown,
                  ) =>
                    Promise.resolve({
                      count:
                        h.state
                          .priorCustomerMsgCount,
                      error: null,
                    }).then(
                      onFulfilled,
                      onRejected,
                    ),
                }

                return chain
              }

              const chain: Record<
                string,
                unknown
              > = {
                eq: () => chain,
                in: () => chain,
                order: () => chain,
                limit: () => chain,

                maybeSingle: () =>
                  Promise.resolve({
                    data:
                      h.state
                        .replyContextParent,
                    error: null,
                  }),

                single: () =>
                  Promise.resolve({
                    data:
                      h.state
                        .replyContextParent,
                    error: null,
                  }),

                then: (
                  onFulfilled?: (
                    value: {
                      data:
                        | { id: string }
                        | null
                      error: null
                    },
                  ) => unknown,
                  onRejected?: (
                    reason: unknown,
                  ) => unknown,
                ) =>
                  Promise.resolve({
                    data:
                      h.state
                        .replyContextParent,
                    error: null,
                  }).then(
                    onFulfilled,
                    onRejected,
                  ),
              }

              return chain
            },

            upsert: (
              row: Record<string, unknown>,
              options: unknown,
            ) => {
              h.state.upsertCalls.push({
                row,
                options,
              })

              return {
                select: () =>
                  Promise.resolve({
                    data:
                      h.state
                        .messageUpsertResult,
                    error: null,
                  }),
              }
            },
          }

        default:
          throw new Error(
            `unexpected table: ${table}`,
          )
      }
    },

    rpc: (
      name: string,
      args: Record<string, unknown>,
    ) => {
      h.state.rpcCalls.push({
        name,
        args,
      })

      return Promise.resolve({
        data: null,
        error: null,
      })
    },

    storage: {
      from(bucket: string) {
        return {
          upload: (
            path: string,
            _body: unknown,
            options: {
              contentType?: string
            },
          ) => {
            h.state.storageUploads.push({
              bucket,
              path,
              options,
            })

            return Promise.resolve({
              error:
                h.state
                  .storageUploadError,
            })
          },

          getPublicUrl: (
            path: string,
          ) => ({
            data: {
              publicUrl:
                `https://cdn.test/${bucket}/${path}`,
            },
          }),
        }
      },
    },
  }),
}))

vi.mock(
  '@/lib/whatsapp/encryption',
  () => ({
    decrypt: () => 'plain-token',
    encrypt: (v: string) => v,
    isLegacyFormat: () => false,
  }),
)

vi.mock(
  '@/lib/whatsapp/meta-api',
  () => ({
    getMediaUrl: vi.fn(),
    downloadMedia: vi.fn(),
  }),
)

vi.mock(
  '@/lib/contacts/dedupe',
  () => ({
    findExistingContact: vi.fn(
      async () => ({
        id: 'contact-1',
        name: 'Ada',
        phone: '15551230000',
      }),
    ),

    isUniqueViolation: () => false,
  }),
)

vi.mock(
  '@/lib/whatsapp/webhook-signature',
  () => ({
    verifyMetaWebhookSignature: () =>
      true,
  }),
)

vi.mock(
  '@/lib/whatsapp/template-webhook',
  () => ({
    isTemplateWebhookField: () => false,
    handleTemplateWebhookChange:
      vi.fn(),
  }),
)

vi.mock(
  '@/lib/automations/engine',
  () => ({
    runAutomationsForTrigger:
      h.runAutomationsForTrigger,
  }),
)

vi.mock(
  '@/lib/flows/engine',
  () => ({
    dispatchInboundToFlows:
      h.dispatchInboundToFlows,
  }),
)

vi.mock(
  '@/lib/ai/auto-reply',
  () => ({
    dispatchInboundToAiReply:
      h.dispatchInboundToAiReply,
  }),
)

vi.mock(
  '@/lib/webhooks/deliver',
  () => ({
    dispatchWebhookEvent:
      h.dispatchWebhookEvent,
  }),
)

// Carrega o route depois que os mocks estão registrados.
import {
  getMediaUrl,
  downloadMedia,
} from '@/lib/whatsapp/meta-api'

let POST: typeof import('./route').POST

beforeAll(async () => {
  const route = await import('./route')
  POST = route.POST
})

const mockGetMediaUrl =
  vi.mocked(getMediaUrl)

const mockDownloadMedia =
  vi.mocked(downloadMedia)

const TEXT_MESSAGE = {
  id: 'wamid.TEST1',
  from: '15551230000',
  timestamp: '1700000000',
  type: 'text',
  text: {
    body: 'hello',
  },
}

function inboundRequest(
  message: Record<
    string,
    unknown
  > = TEXT_MESSAGE,
) {
  const body = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: {
                phone_number_id:
                  'pn-1',
              },

              contacts: [
                {
                  wa_id:
                    '15551230000',

                  profile: {
                    name: 'Ada',
                  },
                },
              ],

              messages: [message],
            },
          },
        ],
      },
    ],
  }

  return {
    text: async () =>
      JSON.stringify(body),

    headers: {
      get: () => 'sha256=stub',
    },
  } as unknown as Request
}

async function runWebhook(
  message?: Record<
    string,
    unknown
  >,
) {
  const res = await POST(
    inboundRequest(message),
  )

  for (
    const cb of
      h.state.afterCallbacks
  ) {
    await cb()
  }

  return res
}

beforeEach(() => {
  vi.clearAllMocks()

  h.state.messageUpsertResult = [
    { id: 'msg-1' },
  ]

  h.state.priorCustomerMsgCount = 0

  h.state.replyContextParent =
    null

  h.state.conversation = {
    id: 'conv-1',
    unread_count: 0,
    account_id: 'acc-1',
    whatsapp_config_id:
      'cfg-1',
  }

  h.state.upsertCalls = []
  h.state.rpcCalls = []
  h.state.afterCallbacks = []

  h.state.automationStarted = 0
  h.state.automationCompleted = 0

  h.state.mirrorInboundMedia =
    true

  h.state.storageUploads = []

  h.state.storageUploadError =
    null

  mockGetMediaUrl.mockResolvedValue({
    url: 'https://lookaside.fbsbx.com/whatsapp/abc',
    mimeType: 'image/jpeg',
    fileSize: 2048,
  })

  mockDownloadMedia.mockResolvedValue({
    buffer: Buffer.alloc(2048),
    contentType: 'image/jpeg',
  })

  h.dispatchInboundToFlows.mockResolvedValue({
    consumed: false,
  })

  h.dispatchInboundToAiReply.mockResolvedValue(
    undefined,
  )

  h.dispatchWebhookEvent.mockResolvedValue(
    undefined,
  )

  h.runAutomationsForTrigger.mockImplementation(
    () => {
      h.state.automationStarted++

      return new Promise<void>(
        (resolve) => {
          setTimeout(() => {
            h.state
              .automationCompleted++

            resolve()
          }, 0)
        },
      )
    },
  )
})

describe(
  'inbound webhook: idempotent insert (#367)',
  () => {
    it(
      'a genuine first delivery persists once and fans out downstream',
      async () => {
        await runWebhook()

        expect(
          h.state.upsertCalls,
        ).toHaveLength(1)

        expect(
          h.state.upsertCalls[0]
            .options,
        ).toMatchObject({
          onConflict:
            'conversation_id,message_id',

          ignoreDuplicates:
            true,
        })

        expect(
          h.dispatchInboundToFlows,
        ).toHaveBeenCalledTimes(1)

        expect(
          h.dispatchWebhookEvent,
        ).toHaveBeenCalledTimes(1)
      },
    )

    it(
      'a replayed delivery is a no-op: no unread bump, no fan-out',
      async () => {
        h.state.messageUpsertResult =
          []

        await runWebhook()

        expect(
          h.state.upsertCalls,
        ).toHaveLength(1)

        expect(
          h.state.rpcCalls,
        ).toHaveLength(0)

        expect(
          h.dispatchInboundToFlows,
        ).not.toHaveBeenCalled()

        expect(
          h.runAutomationsForTrigger,
        ).not.toHaveBeenCalled()

        expect(
          h.dispatchInboundToAiReply,
        ).not.toHaveBeenCalled()

        expect(
          h.dispatchWebhookEvent,
        ).not.toHaveBeenCalled()
      },
    )
  },
)

describe(
  'inbound webhook: atomic unread bump (#369)',
  () => {
    it(
      'increments unread through the DB-side RPC, not a read-modify-write',
      async () => {
        await runWebhook()

        expect(
          h.state.rpcCalls,
        ).toHaveLength(1)

        expect(
          h.state.rpcCalls[0],
        ).toMatchObject({
          name:
            'bump_conversation_on_inbound',

          args: {
            p_conversation_id:
              'conv-1',
          },
        })
      },
    )
  },
)

describe(
  'inbound webhook: template quick-reply buttons (#478)',
  () => {
    const templateButtonTap = {
      id: 'wamid.BTN1',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'button',

      button: {
        text: 'Yes, interested',
        payload:
          'YES_INTERESTED',
      },

      context: {
        id: 'wamid.BROADCAST1',
      },
    }

    it(
      'stores the tap as an interactive reply, not an unsupported message',
      async () => {
        await runWebhook(
          templateButtonTap,
        )

        expect(
          h.state.upsertCalls,
        ).toHaveLength(1)

        expect(
          h.state.upsertCalls[0].row,
        ).toMatchObject({
          content_type:
            'interactive',

          content_text:
            'Yes, interested',

          interactive_reply_id:
            'YES_INTERESTED',

          reply_to_message_id:
            null,
        })
      },
    )

    it(
      'routes the tap to flows and fires the interactive_reply trigger',
      async () => {
        await runWebhook(
          templateButtonTap,
        )

        expect(
          h.dispatchInboundToFlows,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            message: {
              kind:
                'interactive_reply',

              reply_id:
                'YES_INTERESTED',

              reply_title:
                'Yes, interested',

              meta_message_id:
                'wamid.BTN1',
            },
          }),
        )

        const triggers =
          h.runAutomationsForTrigger.mock.calls.map(
            (call) =>
              (
                call[0] as {
                  triggerType: string
                }
              ).triggerType,
          )

        expect(
          triggers,
        ).toContain(
          'interactive_reply',
        )

        expect(
          h.dispatchInboundToAiReply,
        ).not.toHaveBeenCalled()
      },
    )

    it(
      'falls back to the label when the template button carries no payload',
      async () => {
        await runWebhook({
          ...templateButtonTap,

          button: {
            text:
              'Track my order',
          },
        })

        expect(
          h.state.upsertCalls[0]
            .row,
        ).toMatchObject({
          content_type:
            'interactive',

          content_text:
            'Track my order',

          interactive_reply_id:
            'Track my order',
        })
      },
    )
  },
)

describe(
  'inbound webhook: inbound media is mirrored (#466)',
  () => {
    const IMAGE_MESSAGE = {
      id: 'wamid.IMG1',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'image',

      image: {
        id: '1234567890123456',
        mime_type:
          'image/jpeg',
        caption: 'hi',
      },
    }

    it(
      'stores a durable bucket URL instead of the expiring proxy path',
      async () => {
        await runWebhook(
          IMAGE_MESSAGE,
        )

        expect(
          h.state.storageUploads,
        ).toHaveLength(1)

        expect(
          h.state.storageUploads[0]
            .bucket,
        ).toBe('chat-media')

        expect(
          h.state.storageUploads[0]
            .path,
        ).toBe(
          'account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
        )

        expect(
          h.state.upsertCalls[0]
            .row,
        ).toMatchObject({
          media_url:
            'https://cdn.test/chat-media/account-acc-1/inbound/1234567890123456-image-1700000000.jpg',

          media_type:
            'image/jpeg',
        })
      },
    )

    it(
      'falls back to the proxy URL when the upload is refused',
      async () => {
        h.state.storageUploadError =
          {
            message:
              'mime type not supported',
          }

        await runWebhook(
          IMAGE_MESSAGE,
        )

        expect(
          h.state.upsertCalls,
        ).toHaveLength(1)

        expect(
          h.state.upsertCalls[0]
            .row,
        ).toMatchObject({
          media_url:
            '/api/whatsapp/media/1234567890123456',

          media_type:
            'image/jpeg',
        })
      },
    )

    it(
      'falls back to the proxy URL when the download from Meta throws',
      async () => {
        mockDownloadMedia.mockRejectedValueOnce(
          new Error(
            'Media download failed: 404',
          ),
        )

        await runWebhook(
          IMAGE_MESSAGE,
        )

        expect(
          h.state.upsertCalls[0]
            .row,
        ).toMatchObject({
          media_url:
            '/api/whatsapp/media/1234567890123456',
        })
      },
    )

    it(
      'skips media larger than the bucket accepts, without downloading it',
      async () => {
        mockGetMediaUrl.mockResolvedValue(
          {
            url: 'https://lookaside.fbsbx.com/whatsapp/big',
            mimeType:
              'application/pdf',
            fileSize:
              40 * 1024 * 1024,
          },
        )

        await runWebhook({
          id: 'wamid.DOC1',
          from: '15551230000',
          timestamp:
            '1700000000',
          type: 'document',

          document: {
            id: '999',
            mime_type:
              'application/pdf',
            filename:
              'huge.pdf',
          },
        })

        expect(
          mockDownloadMedia,
        ).not.toHaveBeenCalled()

        expect(
          h.state.storageUploads,
        ).toHaveLength(0)

        expect(
          h.state.upsertCalls[0]
            .row,
        ).toMatchObject({
          media_url:
            '/api/whatsapp/media/999',

          media_type:
            'application/pdf',
        })
      },
    )

    it(
      "names the object after a document's own filename",
      async () => {
        mockGetMediaUrl.mockResolvedValue(
          {
            url: 'https://lookaside.fbsbx.com/whatsapp/doc',
            mimeType:
              'application/pdf',
            fileSize: 4096,
          },
        )

        mockDownloadMedia.mockResolvedValue(
          {
            buffer:
              Buffer.alloc(4096),

            contentType:
              'application/pdf',
          },
        )

        await runWebhook({
          id: 'wamid.DOC2',
          from: '15551230000',
          timestamp:
            '1700000000',
          type: 'document',

          document: {
            id: '1234567890123456',
            mime_type:
              'application/pdf',
            filename:
              'invoice.pdf',

            caption:
              'have a look',
          },
        })

        expect(
          h.state.storageUploads[0]
            .path,
        ).toBe(
          'account-acc-1/inbound/1234567890123456-invoice.pdf',
        )
      },
    )

    it(
      'does not mirror when the account has opted out',
      async () => {
        h.state.mirrorInboundMedia =
          false

        await runWebhook(
          IMAGE_MESSAGE,
        )

        expect(
          mockDownloadMedia,
        ).not.toHaveBeenCalled()

        expect(
          h.state.storageUploads,
        ).toHaveLength(0)

        expect(
          h.state.upsertCalls[0]
            .row,
        ).toMatchObject({
          media_url:
            '/api/whatsapp/media/1234567890123456',

          media_type:
            'image/jpeg',
        })
      },
    )

    it(
      'mirrors when the column is absent, e.g. a row read before migration 039',
      async () => {
        h.state.mirrorInboundMedia =
          undefined

        await runWebhook(
          IMAGE_MESSAGE,
        )

        expect(
          h.state.storageUploads,
        ).toHaveLength(1)
      },
    )

    it(
      'leaves text messages alone',
      async () => {
        await runWebhook()

        expect(
          mockGetMediaUrl,
        ).not.toHaveBeenCalled()

        expect(
          h.state.storageUploads,
        ).toHaveLength(0)

        expect(
          h.state.upsertCalls[0]
            .row,
        ).toMatchObject({
          media_type: null,
        })
      },
    )
  },
)

describe(
  'inbound webhook: after() awaits automations (#368)',
  () => {
    it(
      'every triggered automation settles before the after() callback resolves',
      async () => {
        await runWebhook()

        expect(
          h.state.automationStarted,
        ).toBe(3)

        expect(
          h.state.automationCompleted,
        ).toBe(3)
      },
    )
  },
)