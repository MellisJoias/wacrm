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

let adminDbMock:
  | SupabaseClient
  | null = null;

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => {
    if (!adminDbMock) {
      throw new Error(
        'admin db mock not initialized',
      );
    }

    return adminDbMock;
  }),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-access-token',
}));

vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(
    async () => ({
      id: 'c1',
    }),
  ),
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: vi.fn(
    async () => ({
      messageId:
        'wamid-test-1',
    }),
  ),
}));

vi.mock(
  '@/lib/whatsapp/resolve-conversation',
  () => ({
    resolveConversationByPhone:
      vi.fn(
        async () => ({
          conversationId:
            'conv-1',
          contactId:
            'c1',
          contactCreated:
            false,
        }),
      ),
  }),
);

const WHATSAPP_CONFIG_ID =
  'config-1';

const db =
  {} as SupabaseClient;

// ============================================================
// CREATE BROADCAST VALIDATION
// ============================================================

describe(
  'createBroadcast validation',
  () => {
    it(
      'rejects a missing template_name',
      async () => {
        await expect(
          createBroadcast(
            db,
            'acc',
            'user',
            {
              whatsappConfigId:
                WHATSAPP_CONFIG_ID,

              templateName:
                '',

              recipients: [
                {
                  to:
                    '+14155550123',
                },
              ],
            },
          ),
        ).rejects.toMatchObject({
          code:
            'bad_request',

          status:
            400,
        });
      },
    );

    it(
      'rejects an empty recipient list',
      async () => {
        await expect(
          createBroadcast(
            db,
            'acc',
            'user',
            {
              whatsappConfigId:
                WHATSAPP_CONFIG_ID,

              templateName:
                'promo',

              recipients: [],
            },
          ),
        ).rejects.toBeInstanceOf(
          BroadcastError,
        );
      },
    );

    it(
      'rejects more than 1000 recipients',
      async () => {
        const recipients =
          Array.from(
            {
              length:
                1001,
            },
            () => ({
              to:
                '+14155550123',
            }),
          );

        await expect(
          createBroadcast(
            db,
            'acc',
            'user',
            {
              whatsappConfigId:
                WHATSAPP_CONFIG_ID,

              templateName:
                'promo',

              recipients,
            },
          ),
        ).rejects.toMatchObject({
          status:
            400,
        });
      },
    );
  },
);

// ============================================================
// CREATE BROADCAST MOCK DB
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

    usedDirectInsert:
      0,
  };

  const database = {
    from(table: string) {
      if (
        table ===
        'whatsapp_config'
      ) {
        const chain: Record<
          string,
          unknown
        > = {
          select: () =>
            chain,

          eq: () =>
            chain,

          single: () =>
            Promise.resolve({
              data: {
                id:
                  WHATSAPP_CONFIG_ID,

                phone_number_id:
                  'pn-1',

                access_token:
                  'enc',
              },

              error:
                null,
            }),
        };

        return chain;
      }

      if (
        table ===
        'message_templates'
      ) {
        const chain: Record<
          string,
          unknown
        > = {
          select: () =>
            chain,

          eq: () =>
            chain,

          then: (
            resolve: (
              result: {
                data:
                  unknown[];

                error:
                  null;
              },
            ) => unknown,
          ) =>
            resolve({
              data: [],
              error:
                null,
            }),
        };

        return chain;
      }

      if (
        table ===
          'broadcasts' ||
        table ===
          'broadcast_recipients'
      ) {
        calls.usedDirectInsert++;

        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: {
                    id:
                      'orphan',
                  },

                  error:
                    null,
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

      return Promise.resolve(
        rpcResult,
      );
    },
  } as unknown as SupabaseClient;

  adminDbMock =
    database;

  return {
    db: database,
    calls,
  };
}

// ============================================================
// CREATE BROADCAST ATOMICITY
// ============================================================

describe(
  'createBroadcast atomicity (#370)',
  () => {
    beforeEach(() => {
      adminDbMock =
        null;
    });

    it(
      'creates parent + recipients through the atomic RPC, never a bare parent insert',
      async () => {
        const {
          db,
          calls,
        } = makeDb({
          data: [
            {
              broadcast_id:
                'b-1',

              recipient_id:
                'r-1',

              contact_id:
                'c1',
            },
          ],

          error:
            null,
        });

        const plan =
          await createBroadcast(
            db,
            'acc',
            'user',
            {
              whatsappConfigId:
                WHATSAPP_CONFIG_ID,

              templateName:
                'promo',

              recipients: [
                {
                  to:
                    '+14155550123',
                },
              ],
            },
          );

        expect(
          calls.rpc,
        ).toHaveLength(
          1,
        );

        expect(
          calls.rpc[0]
            .name,
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
            recipientRowId:
              'r-1',

            contactId:
              'c1',

            phone:
              '14155550123',

            params: [],
          },
        ]);

        expect(
          plan.whatsappConfigId,
        ).toBe(
          WHATSAPP_CONFIG_ID,
        );
      },
    );

    it(
      'passes frozen template params to the atomic RPC',
      async () => {
        const {
          db,
          calls,
        } = makeDb({
          data: [
            {
              broadcast_id:
                'b-1',

              recipient_id:
                'r-1',

              contact_id:
                'c1',
            },
          ],

          error:
            null,
        });

        await createBroadcast(
          db,
          'acc',
          'user',
          {
            whatsappConfigId:
              WHATSAPP_CONFIG_ID,

            templateName:
              'promo',

            recipients: [
              {
                to:
                  '+14155550123',

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
        ).toHaveLength(
          1,
        );

        const args =
          calls.rpc[0]
            .args as Record<
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
        ).toEqual([
          'c1',
        ]);

        expect(
          args.p_whatsapp_config_id,
        ).toBe(
          WHATSAPP_CONFIG_ID,
        );
      },
    );

    it(
      'throws and leaves no orphaned parent when the atomic create fails',
      async () => {
        const {
          db,
          calls,
        } = makeDb({
          data:
            null,

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
              whatsappConfigId:
                WHATSAPP_CONFIG_ID,

              templateName:
                'promo',

              recipients: [
                {
                  to:
                    '+14155550123',
                },
              ],
            },
          ),
        ).rejects.toBeInstanceOf(
          BroadcastError,
        );

        expect(
          calls.rpc,
        ).toHaveLength(
          1,
        );

        expect(
          calls.usedDirectInsert,
        ).toBe(0);
      },
    );
  },
);

// ============================================================
// DELIVERY TYPES
// ============================================================

interface DeliveryWrites {
  recipientUpdate?:
    Record<
      string,
      unknown
    >;

  messageInsert?:
    Record<
      string,
      unknown
    >;

  conversationUpdate?:
    Record<
      string,
      unknown
    >;
}

function mergeWrite(
  current:
    | Record<
        string,
        unknown
      >
    | undefined,

  next: Record<
    string,
    unknown
  >,
): Record<
  string,
  unknown
> {
  return {
    ...(current ?? {}),
    ...next,
  };
}

// ============================================================
// DELIVERY MOCK DB
// ============================================================

function makeDeliveryDb(
  writes: DeliveryWrites,

  recipientCounts: Record<
    string,
    number
  > = {
    pending: 0,
    failed: 0,
    sent: 1,
  },

  totalRecipients = 1,
) {
  const database = {
    from(table: string) {
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
              mergeWrite(
                writes.recipientUpdate,
                row,
              );

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
                count:
                  number;

                error:
                  null;
              },
            ) => unknown,
          ) => {
            const count =
              selectedStatus ===
              null
                ? totalRecipients
                : (
                    recipientCounts[
                      selectedStatus
                    ] ?? 0
                  );

            return resolve({
              count,

              error:
                null,
            });
          },
        };

        return chain;
      }

      if (
        table ===
        'messages'
      ) {
        const chain: Record<
          string,
          unknown
        > = {
          select: () =>
            chain,

          eq: () =>
            chain,

          maybeSingle: () =>
            Promise.resolve({
              data:
                null,

              error:
                null,
            }),

          insert: (
            row: Record<
              string,
              unknown
            >,
          ) => {
            writes.messageInsert =
              mergeWrite(
                writes.messageInsert,
                row,
              );

            return chain;
          },

          single: () =>
            Promise.resolve({
              data: {
                id:
                  'message-row-1',
              },

              error:
                null,
            }),
        };

        return chain;
      }

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
              mergeWrite(
                writes.conversationUpdate,
                row,
              );

            return chain;
          },

          eq: () =>
            chain,
        };

        return chain;
      }

      if (
        table ===
        'broadcasts'
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

      if (
        table ===
        'whatsapp_config'
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

// ============================================================
// DELIVERY TESTS
// ============================================================

describe(
  'deliverBroadcast conversation persistence',
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it(
      'persists the successful broadcast message in the canonical conversation',
      async () => {
        const writes:
          DeliveryWrites =
          {};

        const deliveryDb =
          makeDeliveryDb(
            writes,
          );

        const plan = {
          broadcastId:
            'b-1',

          accountId:
            'acc',

          auditUserId:
            'user',

          whatsappConfigId:
            WHATSAPP_CONFIG_ID,

          templateName:
            'promo',

          templateLanguage:
            'en_US',

          phoneNumberId:
            'pn-1',

          accessToken:
            'plain-access-token',

          templateRow: {
            id:
              'template-1',

            account_id:
              'acc',

            name:
              'promo',

            language:
              'en_US',

            body_text:
              'Olá {{1}}, sua oferta é {{2}}.',
          } as {
            id: string;
            account_id: string;
            name: string;
            language: string;
            body_text: string;
          },

          planned: [
            {
              recipientRowId:
                'r-1',

              contactId:
                'c1',

              phone:
                '14155550123',

              params: [
                'Maria',
                'R$ 100,00',
              ],
            },
          ],

          rejected:
            0,
        };

        await deliverBroadcast(
          deliveryDb,
          plan,
        );

        expect(
          writes.recipientUpdate,
        ).toMatchObject({
          status:
            'sent',

          whatsapp_message_id:
            'wamid-test-1',

          error_message:
            null,

          message_text:
            'Olá Maria, sua oferta é R$ 100,00.',
        });

        expect(
          writes.messageInsert,
        ).toMatchObject({
          conversation_id:
            'conv-1',

          sender_type:
            'agent',

          sender_id:
            'user',

          content_type:
            'template',

          content_text:
            'Olá Maria, sua oferta é R$ 100,00.',

          template_name:
            'promo',

          message_id:
            'wamid-test-1',

          status:
            'sent',
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
        const writes:
          DeliveryWrites =
          {};

        const deliveryDb =
          makeDeliveryDb(
            writes,
          );

        const {
          resolveConversationByPhone,
        } =
          await import(
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
          broadcastId:
            'b-2',

          accountId:
            'acc',

          auditUserId:
            'user',

          whatsappConfigId:
            WHATSAPP_CONFIG_ID,

          templateName:
            'promo',

          templateLanguage:
            'en_US',

          phoneNumberId:
            'pn-1',

          accessToken:
            'plain-access-token',

          templateRow: {
            id:
              'template-1',

            account_id:
              'acc',

            name:
              'promo',

            language:
              'en_US',

            body_text:
              'Promo para {{1}}',
          } as {
            id: string;
            account_id: string;
            name: string;
            language: string;
            body_text: string;
          },

          planned: [
            {
              recipientRowId:
                'r-2',

              contactId:
                'existing-contact',

              phone:
                '5511999999999',

              params: [
                'João',
              ],
            },
          ],

          rejected:
            0,
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
          WHATSAPP_CONFIG_ID,
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
        const writes:
          DeliveryWrites =
          {};

        const database = {
          from(table: string) {
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
                    mergeWrite(
                      writes.recipientUpdate,
                      row,
                    );

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
                      count:
                        number;

                      error:
                        null;
                    },
                  ) => unknown,
                ) => {
                  const counts: Record<
                    string,
                    number
                  > = {
                    pending:
                      0,

                    failed:
                      0,

                    sent:
                      1,
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

                    error:
                      null,
                  });
                },
              };

              return chain;
            }

            if (
              table ===
              'messages'
            ) {
              const insertChain: Record<
                string,
                unknown
              > = {
                select: () =>
                  insertChain,

                single: () =>
                  Promise.resolve({
                    data:
                      null,

                    error: {
                      message:
                        'messages insert failed',
                    },
                  }),
              };

              const chain: Record<
                string,
                unknown
              > = {
                select: () =>
                  chain,

                eq: () =>
                  chain,

                maybeSingle: () =>
                  Promise.resolve({
                    data:
                      null,

                    error:
                      null,
                  }),

                insert: (
                  row: Record<
                    string,
                    unknown
                  >,
                ) => {
                  writes.messageInsert =
                    mergeWrite(
                      writes.messageInsert,
                      row,
                    );

                  return insertChain;
                },
              };

              return chain;
            }

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
                    mergeWrite(
                      writes.conversationUpdate,
                      row,
                    );

                  return chain;
                },

                eq: () =>
                  chain,
              };

              return chain;
            }

            if (
              table ===
              'broadcasts'
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
          broadcastId:
            'b-3',

          accountId:
            'acc',

          auditUserId:
            'user',

          whatsappConfigId:
            WHATSAPP_CONFIG_ID,

          templateName:
            'promo',

          templateLanguage:
            'en_US',

          phoneNumberId:
            'pn-1',

          accessToken:
            'plain-access-token',

          templateRow: {
            id:
              'template-1',

            account_id:
              'acc',

            name:
              'promo',

            language:
              'en_US',

            body_text:
              'Promo {{1}}',
          } as {
            id: string;
            account_id: string;
            name: string;
            language: string;
            body_text: string;
          },

          planned: [
            {
              recipientRowId:
                'r-3',

              contactId:
                'c1',

              phone:
                '14155550123',

              params: [
                'Maria',
              ],
            },
          ],

          rejected:
            0,
        };

        await deliverBroadcast(
          database,
          plan,
        );

        expect(
          writes.recipientUpdate,
        ).toMatchObject({
          status:
            'sent',

          whatsapp_message_id:
            'wamid-test-1',
        });

        expect(
          writes.recipientUpdate?.status,
        ).not.toBe(
          'failed',
        );
      },
    );
  },
);

// ============================================================
// FINALIZE MOCK
// ============================================================

function statusDb(
  counts: Record<
    string,
    number
  >,

  total: number,

  writes: {
    update?:
      Record<
        string,
        unknown
      >;
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
        select: () =>
          b,

        eq: (
          col: string,
          val: unknown,
        ) => {
          if (
            col ===
            'status'
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
              count:
                number;

              error:
                null;
            },
          ) => unknown,
        ) =>
          resolve({
            count:
              status ===
              null
                ? total
                : (
                    counts[
                      status
                    ] ?? 0
                  ),

            error:
              null,
          }),
      };

      return b;
    },
  } as unknown as SupabaseClient;
}

// ============================================================
// FINALIZE TESTS
// ============================================================

describe(
  'finalizeBroadcastStatus',
  () => {
    it(
      'leaves a capped pass in "sending" while recipients are still pending',
      async () => {
        const writes: {
          update?:
            Record<
              string,
              unknown
            >;
        } = {};

        await finalizeBroadcastStatus(
          statusDb(
            {
              pending:
                25,
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
          update?:
            Record<
              string,
              unknown
            >;
        } = {};

        await finalizeBroadcastStatus(
          statusDb(
            {
              pending:
                0,

              failed:
                10,
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
          update?:
            Record<
              string,
              unknown
            >;
        } = {};

        await finalizeBroadcastStatus(
          statusDb(
            {
              pending:
                0,

              failed:
                3,
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
          update?:
            Record<
              string,
              unknown
            >;
        } = {};

        await finalizeBroadcastStatus(
          statusDb(
            {
              pending:
                0,

              failed:
                200,
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