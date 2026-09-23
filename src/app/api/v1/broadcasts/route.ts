import { after } from 'next/server';

import {
  getCurrentAccount,
  UnauthorizedError,
  ForbiddenError,
} from '@/lib/auth/account';

import { requireApiKey } from '@/lib/auth/api-context';

import {
  ok,
  fail,
  toApiErrorResponse,
} from '@/lib/api/v1/respond';

import {
  resolveAuditUserId,
  ContactError,
} from '@/lib/api/v1/contacts';

import {
  createBroadcast,
  deliverBroadcast,
  BroadcastError,
  limitBroadcastPlan,
} from '@/lib/whatsapp/broadcast-core';

import { supabaseAdmin } from '@/lib/flows/admin-client';

// ============================================================
// POST /api/v1/broadcasts
//
// Cria a campanha e inicia o primeiro delivery pass.
//
// IMPORTANTE:
//
// O navegador recebe 202 imediatamente.
//
// O processamento usa service-role.
//
// O envio é:
//   1 destinatário
//   -> await Meta
//   -> salva resultado
//   -> próximo destinatário
//
// Cada pass envia no máximo DELIVERY_BATCH_SIZE recipients.
//
// Quando o lote termina e ainda existem pending,
// o servidor dispara automaticamente o próximo pass.
//
// O intervalo de 20 segundos entre blocos é controlado
// exclusivamente pela rota de continuação [id]/route.ts.
// ============================================================

export const maxDuration = 300;

// ============================================================
// Internal continuation
// ============================================================
//
// Depois que o primeiro lote termina, esta função chama a rota
// central de continuação:
//
// /api/v1/broadcasts/[id]
//
// Essa rota já possui:
// - controle de lock
// - planejamento do próximo lote
// - limite de 12 por pass
// - envio sequencial
// - verificação dos pending
// - espera de 20 segundos entre os passes
// - continuação automática dos próximos passes
//
// A autenticação interna utiliza BROADCAST_INTERNAL_SECRET.
// ============================================================

async function triggerNextBroadcastPass(
  request: Request,
  broadcastId: string,
): Promise<void> {
  const secret =
    process.env.BROADCAST_INTERNAL_SECRET;

  if (
    !secret ||
    secret.length === 0
  ) {
    console.error(
      '[broadcast-resume] BROADCAST_INTERNAL_SECRET is not configured. Automatic continuation cannot run.',
    );

    return;
  }

  const origin =
    new URL(request.url).origin;

  const url =
    `${origin}/api/v1/broadcasts/${encodeURIComponent(
      broadcastId,
    )}`;

  try {
    console.log(
      '[broadcast-resume] triggering next delivery pass:',
      {
        broadcastId,
        url,
      },
    );

    const response =
      await fetch(
        url,
        {
          method: 'POST',

          headers: {
            'content-type':
              'application/json',

            'x-broadcast-internal-secret':
              secret,
          },

          body:
            JSON.stringify({
              scope: 'pending',
            }),

          cache:
            'no-store',
        },
      );

    const text =
      await response
        .text()
        .catch(
          () => '',
        );

    if (
      !response.ok
    ) {
      console.error(
        '[broadcast-resume] next pass returned non-2xx:',
        {
          broadcastId,

          status:
            response.status,

          body:
            text,
        },
      );

      return;
    }

    console.log(
      '[broadcast-resume] next delivery pass accepted:',
      {
        broadcastId,

        status:
          response.status,

        body:
          text,
      },
    );
  } catch (error) {
    console.error(
      '[broadcast-resume] failed to trigger next pass:',
      {
        broadcastId,

        error,
      },
    );
  }
}

type BroadcastAuthContext = {
  supabase: Awaited<
    ReturnType<typeof getCurrentAccount>
  >['supabase'];

  accountId: string;

  userId: string;

  authType:
    | 'session'
    | 'api_key';
};

// ============================================================
// Authentication
// ============================================================

async function resolveBroadcastAuth(
  request: Request,
): Promise<BroadcastAuthContext> {
  const authorization =
    request.headers.get(
      'authorization',
    );

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  if (
    authorization &&
    authorization.trim().length > 0
  ) {
    const ctx =
      await requireApiKey(
        request,
        'broadcasts:send',
      );

    const userId =
      await resolveAuditUserId(
        ctx.supabase,
        ctx.accountId,
      );

    return {
      supabase:
        ctx.supabase,

      accountId:
        ctx.accountId,

      userId,

      authType:
        'api_key',
    };
  }

  // ----------------------------------------------------------
  // WACRM interno
  // ----------------------------------------------------------

  const ctx =
    await getCurrentAccount();

  return {
    supabase:
      ctx.supabase,

    accountId:
      ctx.accountId,

    userId:
      ctx.userId,

    authType:
      'session',
  };
}

// ============================================================
// POST
// ============================================================

export async function POST(
  request: Request,
) {
  try {
    // ----------------------------------------------------------
    // Authentication
    // ----------------------------------------------------------

    const ctx =
      await resolveBroadcastAuth(
        request,
      );

    // ----------------------------------------------------------
    // Parse body
    // ----------------------------------------------------------

    const body =
      (await request
        .json()
        .catch(
          () => null,
        )) as Record<
        string,
        unknown
      > | null;

    if (
      !body ||
      typeof body !== 'object'
    ) {
      return fail(
        'bad_request',
        'Request body must be a JSON object',
        400,
      );
    }

    // ----------------------------------------------------------
    // Request data
    // ----------------------------------------------------------

    const templateName =
      typeof body.template_name ===
      'string'
        ? body.template_name
        : '';

    const recipients =
      Array.isArray(
        body.recipients,
      )
        ? body.recipients
        : [];

    // ----------------------------------------------------------
    // Normalize recipients
    // ----------------------------------------------------------

    const normalizedRecipients =
      recipients.map(
        (recipient) => {
          const value =
            recipient as Record<
              string,
              unknown
            >;

          return {
            to:
              typeof value?.to ===
              'string'
                ? value.to
                : '',

            params:
              Array.isArray(
                value?.params,
              )
                ? value.params.filter(
                    (
                      param,
                    ): param is string =>
                      typeof param ===
                      'string',
                  )
                : undefined,
          };
        },
      );

    // ----------------------------------------------------------
    // Persist broadcast
    // ----------------------------------------------------------

    const plan =
      await createBroadcast(
        ctx.supabase,
        ctx.accountId,
        ctx.userId,
        {
          name:
            typeof body.name ===
            'string'
              ? body.name
              : null,

          templateName,

          templateLanguage:
            typeof body.template_language ===
            'string'
              ? body.template_language
              : null,

          recipients:
            normalizedRecipients,

          headerMediaUrl:
            typeof body.header_media_url ===
            'string'
              ? body.header_media_url
              : null,
        },
      );

    // ----------------------------------------------------------
    // First delivery pass
    // ----------------------------------------------------------
    //
    // O broadcast pode conter centenas de recipients.
    //
    // Não enviamos todos dentro de uma única execução.
    //
    // O primeiro pass recebe somente o tamanho definido pelo
    // DELIVERY_BATCH_SIZE no broadcast-core.ts.
    // ----------------------------------------------------------

    const firstPass =
      limitBroadcastPlan(
        plan,
      );

    const admin =
      supabaseAdmin();

    // ----------------------------------------------------------
    // Server-side delivery
    // ----------------------------------------------------------

    after(async () => {
      let shouldContinue =
        false;

      try {
        console.log(
          '[POST /api/v1/broadcasts] starting first delivery pass:',
          {
            broadcastId:
              plan.broadcastId,

            total:
              plan.planned.length,

            passSize:
              firstPass.planned.length,
          },
        );

        // ------------------------------------------------------
        // Send first pass sequentially.
        // ------------------------------------------------------

        await deliverBroadcast(
          admin,
          firstPass,
        );

        console.log(
          '[POST /api/v1/broadcasts] first delivery pass finished:',
          {
            broadcastId:
              plan.broadcastId,
          },
        );

        // ------------------------------------------------------
        // Determine whether pending recipients remain.
        // ------------------------------------------------------

        const {
          count:
            pendingCount,

          error:
            pendingError,
        } =
          await admin
            .from(
              'broadcast_recipients',
            )
            .select(
              'id',
              {
                count:
                  'exact',

                head:
                  true,
              },
            )
            .eq(
              'broadcast_id',
              plan.broadcastId,
            )
            .eq(
              'status',
              'pending',
            );

        if (
          pendingError
        ) {
          console.error(
            '[broadcast-resume] failed checking pending recipients:',
            pendingError,
          );

          return;
        }

        shouldContinue =
          (pendingCount ?? 0) > 0;

        console.log(
          '[broadcast-resume] first pass completed:',
          {
            broadcastId:
              plan.broadcastId,

            pending:
              pendingCount ?? 0,

            shouldContinue,
          },
        );
      } catch (error) {
        console.error(
          '[POST /api/v1/broadcasts] asynchronous delivery failed:',
          {
            broadcastId:
              plan.broadcastId,

            accountId:
              ctx.accountId,

            authType:
              ctx.authType,

            error,
          },
        );
      }

      // --------------------------------------------------------
      // Automatically start next pass.
      // --------------------------------------------------------
      //
      // A própria rota de continuação controla os 20 segundos
      // antes do próximo bloco.
      // --------------------------------------------------------

      if (
        shouldContinue
      ) {
        await triggerNextBroadcastPass(
          request,
          plan.broadcastId,
        );
      }
    });

    // ----------------------------------------------------------
    // Immediate response
    // ----------------------------------------------------------

    return ok(
      {
        broadcast_id:
          plan.broadcastId,

        status:
          'sending',

        total_recipients:
          plan.planned.length,

        accepted:
          plan.planned.length,

        rejected:
          plan.rejected,

        automatic_continuation:
          true,
      },
      202,
    );
  } catch (err) {
    // ----------------------------------------------------------
    // Broadcast errors
    // ----------------------------------------------------------

    if (
      err instanceof BroadcastError
    ) {
      return fail(
        err.code,
        err.message,
        err.status,
      );
    }

    // ----------------------------------------------------------
    // Contact errors
    // ----------------------------------------------------------

    if (
      err instanceof ContactError
    ) {
      return fail(
        err.status === 400
          ? 'bad_request'
          : 'internal',

        err.message,

        err.status,
      );
    }

    // ----------------------------------------------------------
    // Authentication errors
    // ----------------------------------------------------------

    if (
      err instanceof
        UnauthorizedError ||
      err instanceof
        ForbiddenError
    ) {
      return fail(
        err.status === 401
          ? 'unauthorized'
          : 'forbidden',

        err.message,

        err.status,
      );
    }

    // ----------------------------------------------------------
    // Unknown
    // ----------------------------------------------------------

    return toApiErrorResponse(
      err,
    );
  }
}