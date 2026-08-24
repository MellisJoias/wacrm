import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createBroadcast,
  deliverBroadcast,
  finalizeBroadcastStatus,
  BroadcastError,
} from './broadcast-core';

// ============================================================
// Mocks
// ============================================================

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-access-token',
}));

vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async () => ({
    id: 'c1',
  })),
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: vi.fn(async () => ({
    messageId: 'wamid-test-1',
  })),
}));

vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: vi.fn(async () => ({
    conversationId: 'conv-1',
    contactId: 'c1',
    contactCreated: false,
  })),
}));

// ============================================================
// Pure validation
// ============================================================

const db = {} as SupabaseClient;

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [
          {
            to: '+14155550123',
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      }),
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from(
      { length: 1001 },
      () => ({
        to: '+14155550123',
      }),
    );

    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients,
      }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});

// ============================================================
// createBroadcast persistence
// ============================================================

function makeDb(
  rpcResult: {
    data: unknown;
    error: unknown;
  },
) {
  const calls = {
    rpc: [] as {
      name: string;
      args: unknown;
    }[],

    usedDirectInsert: 0,
  };

  const database = {
    from(table: string) {
      // --------------------------------------------------------
      // WhatsApp config
      // --------------------------------------------------------

      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: {
                    phone_number_id: 'pn-1',
                    access_token: 'enc',
                  },
                  error: null,
                }),
            }),
          }),
        };
      }

      // --------------------------------------------------------
      // Message templates
      // --------------------------------------------------------

      if (table === 'message_templates') {
        const chain: Record<string, unknown> = {
          select: () => chain,

          eq: () => chain,

          then: (
            resolve: (
              result: {
                data: unknown[];
                error: null;
              }
            ) => unknown,
          ) =>
            resolve({
              data: [],
              error: null,
            }),
        };

        return chain;
      }

      // --------------------------------------------------------
      // Direct inserts are forbidden.
      //
      // createBroadcast MUST use the atomic RPC.
      // --------------------------------------------------------

      if (
        table === 'broadcasts' ||
        table === 'broadcast_recipients'
      ) {
        calls.usedDirectInsert++;

        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: {
                    id: 'orphan',
                  },
                  error: null,
                }),
            }),
          }),
        };
      }

      throw new Error(
        `unexpected table: ${table}`,
      );
    },

    rpc(
      name: string,
      args: unknown,
    ) {
      calls.rpc.push({
        name,
        args,
      });

      return Promise.resolve(rpcResult);
    },
  } as unknown as SupabaseClient;

  return {
    db: database,
    calls,
  };
}

describe('createBroadcast atomicity (#370)', () => {
  it('creates parent + recipients through the atomic RPC, never a bare parent insert', async () => {
    const { db, calls } = makeDb({
      data: [
        {
          broadcast_id: 'b-1',
          recipient_id: 'r-1',
          contact_id: 'c1',
        },
      ],
      error: null,
    });

    const plan = await createBroadcast(
      db,
      'acc',
      'user',
      {
        templateName: 'promo',
        recipients: [
          {
            to: '+14155550123',
          },
        ],
      },
    );

    expect(calls.rpc).toHaveLength(1);

    expect(
      calls.rpc[0].name,
    ).toBe(
      'create_broadcast_with_recipients',
    );

    expect(
      calls.usedDirectInsert,
    ).toBe(0);

    expect(
      plan.broadcastId,
    ).toBe('b-1');

    expect(
      plan.planned,
    ).toEqual([
      {
        recipientRowId: 'r-1',
        contactId: 'c1',
        phone: '14155550123',
        params: [],
      },
    ]);
  });

  it('passes frozen template params to the atomic RPC', async () => {
    const { db, calls } = makeDb({
      data: [
        {
          broadcast_id: 'b-1',
          recipient_id: 'r-1',
          contact_id: 'c1',
        },
      ],
      error: null,
    });

    await createBroadcast(
      db,
      'acc',
      'user',
      {
        templateName: 'promo',
        recipients: [
          {
            to: '+14155550123',
            params: [
              'Maria',
              'R$ 100,00',
            ],
          },
        ],
      },
    );

    expect(
      calls.rpc,
    ).toHaveLength(1);

    const args =
      calls.rpc[0].args as Record<
        string,
        unknown
      >;

    expect(
      args.p_template_params,
    ).toEqual([
      [
        'Maria',
        'R$ 100,00',
      ],
    ]);

    expect(
      args.p_contact_ids,
    ).toEqual(['c1']);
  });

  it('throws and leaves no orphaned parent when the atomic create fails', async () => {
    const { db, calls } = makeDb({
      data: null,
      error: {
        message:
          'recipient insert failed',
      },
    });

    await expect(
      createBroadcast(
        db,
        'acc',
        'user',
        {
          templateName: 'promo',
          recipients: [
            {
              to: '+14155550123',
            },
          ],
        },
      ),
    ).rejects.toBeInstanceOf(
      BroadcastError,
    );

    expect(
      calls.rpc,
    ).toHaveLength(1);

    expect(
      calls.usedDirectInsert,
    ).toBe(0);
  });
});

// ============================================================
// Broadcast delivery
//
// Meta accepts the message
//        ↓
// resolve the EXISTING conversation
//        ↓
// insert messages using that conversation_id
//
// The broadcast must NOT create a second conversation.
// ============================================================

interface DeliveryWrites {
  recipientUpdate?: Record<string, unknown>;
  messageInsert?: Record<string, unknown>;
  conversationUpdate?: Record<string, unknown>;
}

function makeDeliveryDb(
  writes: DeliveryWrites,
  recipientCounts: Record<string, number> = {
    pending: 0,
    failed: 0,
    sent: 1,
  },
  totalRecipients = 1,
) {
  const database = {
    from(table: string) {
      // --------------------------------------------------------
      // Broadcast recipients
      //
      // This mock must support BOTH:
      //
      // 1. update(...).eq(...)
      //
      // 2. select(..., { count: 'exact', head: true })
      //
      // The second one is used by finalizeBroadcastStatus().
      // --------------------------------------------------------

      if (
        table === 'broadcast_recipients'
      ) {
        let selectedStatus:
          | string
          | null = null;

        const chain: Record<
          string,
          unknown
        > = {
          update: (
            row: Record<string, unknown>,
          ) => {
            writes.recipientUpdate =
              row;

            return chain;
          },

          select: () => {
            return chain;
          },

          eq: (
            column: string,
            value: unknown,
          ) => {
            if (
              column === 'status'
            ) {
              selectedStatus =
                value as string;
            }

            return chain;
          },

          then: (
            resolve: (
              result: {
                count: number;
                error: null;
              }
            ) => unknown,
          ) => {
            const count =
              selectedStatus === null
                ? totalRecipients
                : (
                    recipientCounts[
                      selectedStatus
                    ] ?? 0
                  );

            return resolve({
              count,
              error: null,
            });
          },
        };

        return chain;
      }

      // --------------------------------------------------------
      // Messages
      // --------------------------------------------------------

      if (table === 'messages') {
        const chain: Record<
          string,
          unknown
        > = {
          insert: (
            row: Record<string, unknown>,
          ) => {
            writes.messageInsert =
              row;

            return Promise.resolve({
              data: null,
              error: null,
            });
          },
        };

        return chain;
      }

      // --------------------------------------------------------
      // Conversations
      // --------------------------------------------------------

      if (table === 'conversations') {
        const chain: Record<
          string,
          unknown
        > = {
          update: (
            row: Record<string, unknown>,
          ) => {
            writes.conversationUpdate =
              row;

            return chain;
          },

          eq: () => chain,
        };

        return chain;
      }

      // --------------------------------------------------------
      // Broadcast
      //
      // finalizeBroadcastStatus writes only the terminal status.
      // --------------------------------------------------------

      if (table === 'broadcasts') {
        const chain: Record<
          string,
          unknown
        > = {
          update: () => chain,

          eq: () => chain,
        };

        return chain;
      }

      if (
        table === 'whatsapp_config'
      ) {
        throw new Error(
          'unexpected whatsapp_config access during delivery',
        );
      }

      throw new Error(
        `unexpected table during delivery: ${table}`,
      );
    },
  } as unknown as SupabaseClient;

  return database;
}

describe(
  'deliverBroadcast conversation persistence',
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it(
      'persists the successful broadcast message in the canonical conversation',
      async () => {
        const writes: DeliveryWrites = {};

        const deliveryDb =
          makeDeliveryDb(
            writes,
          );

        const plan = {
          broadcastId: 'b-1',
          accountId: 'acc',
          auditUserId: 'user',

          templateName: 'promo',
          templateLanguage:
            'en_US',

          phoneNumberId: 'pn-1',
          accessToken:
            'plain-access-token',

          templateRow: {
            id: 'template-1',
            account_id: 'acc',
            name: 'promo',
            language: 'en_US',
            body_text:
              'Olá {{1}}, sua oferta é {{2}}.',
          } as any,

          planned: [
            {
              recipientRowId: 'r-1',
              contactId: 'c1',
              phone: '14155550123',
              params: [
                'Maria',
                'R$ 100,00',
              ],
            },
          ],

          rejected: 0,
        };

        await deliverBroadcast(
          deliveryDb,
          plan,
        );

        expect(
          writes.recipientUpdate,
        ).toMatchObject({
          status: 'sent',
          whatsapp_message_id:
            'wamid-test-1',
          error_message: null,
        });

        expect(
          writes.messageInsert,
        ).toMatchObject({
          conversation_id:
            'conv-1',

          sender_type: 'agent',

          sender_id: 'user',

          content_type:
            'template',

          content_text:
            'Olá Maria, sua oferta é R$ 100,00.',

          template_name:
            'promo',

          message_id:
            'wamid-test-1',

          status: 'sent',
        });

        expect(
          writes.conversationUpdate,
        ).toMatchObject({
          last_message_text:
            'Olá Maria, sua oferta é R$ 100,00.',
        });
      },
    );

    it(
      'resolves the conversation by phone before inserting the message',
      async () => {
        const writes: DeliveryWrites = {};

        const deliveryDb =
          makeDeliveryDb(
            writes,
          );

        const {
          resolveConversationByPhone,
        } = await import(
          '@/lib/whatsapp/resolve-conversation'
        );

        const resolver =
          vi.mocked(
            resolveConversationByPhone,
          );

        resolver.mockResolvedValueOnce({
          conversationId:
            'existing-conversation',

          contactId:
            'existing-contact',

          contactCreated:
            false,
        });

        const plan = {
          broadcastId: 'b-2',
          accountId: 'acc',
          auditUserId: 'user',

          templateName: 'promo',
          templateLanguage:
            'en_US',

          phoneNumberId: 'pn-1',
          accessToken:
            'plain-access-token',

          templateRow: {
            id: 'template-1',
            account_id: 'acc',
            name: 'promo',
            language: 'en_US',
            body_text:
              'Promo para {{1}}',
          } as any,

          planned: [
            {
              recipientRowId: 'r-2',
              contactId: 'existing-contact',
              phone:
                '5511999999999',

              params: [
                'João',
              ],
            },
          ],

          rejected: 0,
        };

        await deliverBroadcast(
          deliveryDb,
          plan,
        );

        expect(
          resolver,
        ).toHaveBeenCalledWith(
          deliveryDb,
          'acc',
          '5511999999999',
        );

        expect(
          writes.messageInsert,
        ).toMatchObject({
          conversation_id:
            'existing-conversation',

          message_id:
            'wamid-test-1',
        });
      },
    );

    it(
      'does not mark the recipient failed when local message persistence fails after Meta accepted the message',
      async () => {
        const writes: DeliveryWrites = {};

        const database = {
          from(table: string) {
            // --------------------------------------------------
            // Broadcast recipients
            // --------------------------------------------------

            if (
              table ===
              'broadcast_recipients'
            ) {
              let selectedStatus:
                | string
                | null = null;

              const chain: Record<
                string,
                unknown
              > = {
                update: (
                  row: Record<
                    string,
                    unknown
                  >,
                ) => {
                  writes.recipientUpdate =
                    row;

                  return chain;
                },

                select: () =>
                  chain,

                eq: (
                  column: string,
                  value: unknown,
                ) => {
                  if (
                    column ===
                    'status'
                  ) {
                    selectedStatus =
                      value as string;
                  }

                  return chain;
                },

                then: (
                  resolve: (
                    result: {
                      count: number;
                      error: null;
                    }
                  ) => unknown,
                ) => {
                  const counts: Record<
                    string,
                    number
                  > = {
                    pending: 0,
                    failed: 0,
                    sent: 1,
                  };

                  const count =
                    selectedStatus ===
                    null
                      ? 1
                      : (
                          counts[
                            selectedStatus
                          ] ?? 0
                        );

                  return resolve({
                    count,
                    error: null,
                  });
                },
              };

              return chain;
            }

            // --------------------------------------------------
            // Messages
            //
            // Meta accepted the message,
            // but local persistence fails.
            // --------------------------------------------------

            if (
              table === 'messages'
            ) {
              return {
                insert: () =>
                  Promise.resolve({
                    data: null,
                    error: {
                      message:
                        'messages insert failed',
                    },
                  }),
              };
            }

            // --------------------------------------------------
            // Conversations
            // --------------------------------------------------

            if (
              table ===
              'conversations'
            ) {
              const chain: Record<
                string,
                unknown
              > = {
                update: (
                  row: Record<
                    string,
                    unknown
                  >,
                ) => {
                  writes.conversationUpdate =
                    row;

                  return chain;
                },

                eq: () =>
                  chain,
              };

              return chain;
            }

            // --------------------------------------------------
            // Broadcast
            // --------------------------------------------------

            if (
              table === 'broadcasts'
            ) {
              const chain: Record<
                string,
                unknown
              > = {
                update: () =>
                  chain,

                eq: () =>
                  chain,
              };

              return chain;
            }

            throw new Error(
              `unexpected table: ${table}`,
            );
          },
        } as unknown as SupabaseClient;

        const plan = {
          broadcastId: 'b-3',
          accountId: 'acc',
          auditUserId: 'user',

          templateName: 'promo',
          templateLanguage:
            'en_US',

          phoneNumberId: 'pn-1',
          accessToken:
            'plain-access-token',

          templateRow: {
            id: 'template-1',
            account_id: 'acc',
            name: 'promo',
            language: 'en_US',
            body_text:
              'Promo {{1}}',
          } as any,

          planned: [
            {
              recipientRowId: 'r-3',
              contactId: 'c1',
              phone:
                '14155550123',

              params: [
                'Maria',
              ],
            },
          ],

          rejected: 0,
        };

        await deliverBroadcast(
          database,
          plan,
        );

        // Meta accepted the message.
        // Therefore the recipient MUST remain "sent"
        // even if local message persistence fails.

        expect(
          writes.recipientUpdate,
        ).toMatchObject({
          status: 'sent',

          whatsapp_message_id:
            'wamid-test-1',
        });

        expect(
          writes.recipientUpdate?.status,
        ).not.toBe('failed');
      },
    );
  },
);

// ============================================================
// Terminal status (#472)
//
// Derived from recipient rows, not from a local counter belonging
// to one delivery pass.
// ============================================================

function statusDb(
  counts: Record<string, number>,
  total: number,
  writes: {
    update?: Record<string, unknown>;
  },
) {
  return {
    from(table: string) {
      let status:
        | string
        | null = null;

      const b: Record<
        string,
        unknown
      > = {
        select: () => b,

        eq: (
          col: string,
          val: unknown,
        ) => {
          if (
            col === 'status'
          ) {
            status =
              val as string;
          }

          return b;
        },

        update: (
          row: Record<
            string,
            unknown
          >,
        ) => {
          if (
            table ===
            'broadcasts'
          ) {
            writes.update =
              row;
          }

          return b;
        },

        then: (
          resolve: (
            result: {
              count: number;
              error: null;
            }
          ) => unknown,
        ) =>
          resolve({
            count:
              status === null
                ? total
                : (
                    counts[
                      status
                    ] ?? 0
                  ),

            error: null,
          }),
      };

      return b;
    },
  } as unknown as SupabaseClient;
}

describe(
  'finalizeBroadcastStatus',
  () => {
    it(
      'leaves a capped pass in "sending" while recipients are still pending',
      async () => {
        const writes: {
          update?: Record<
            string,
            unknown
          >;
        } = {};

        await finalizeBroadcastStatus(
          statusDb(
            {
              pending: 25,
            },
            1025,
            writes,
          ),
          'b-1',
        );

        expect(
          writes.update,
        ).toBeUndefined();
      },
    );

    it(
      'marks a fully-failed broadcast failed',
      async () => {
        const writes: {
          update?: Record<
            string,
            unknown
          >;
        } = {};

        await finalizeBroadcastStatus(
          statusDb(
            {
              pending: 0,
              failed: 10,
            },
            10,
            writes,
          ),
          'b-1',
        );

        expect(
          writes.update?.status,
        ).toBe(
          'failed',
        );
      },
    );

    it(
      'marks a partially-failed broadcast sent',
      async () => {
        const writes: {
          update?: Record<
            string,
            unknown
          >;
        } = {};

        await finalizeBroadcastStatus(
          statusDb(
            {
              pending: 0,
              failed: 3,
            },
            10,
            writes,
          ),
          'b-1',
        );

        expect(
          writes.update?.status,
        ).toBe(
          'sent',
        );
      },
    );

    it(
      'does not condemn a campaign whose resume pass sent nothing new',
      async () => {
        const writes: {
          update?: Record<
            string,
            unknown
          >;
        } = {};

        // 800 were already delivered.
        // The resume pass contains the remaining
        // 200 and all 200 fail.
        //
        // Aggregate:
        //
        // total  = 1000
        // failed = 200
        // sent   = 800
        //
        // Therefore the broadcast is "sent".

        await finalizeBroadcastStatus(
          statusDb(
            {
              pending: 0,
              failed: 200,
            },
            1000,
            writes,
          ),
          'b-1',
        );

        expect(
          writes.update?.status,
        ).toBe(
          'sent',
        );
      },
    );
  },
);