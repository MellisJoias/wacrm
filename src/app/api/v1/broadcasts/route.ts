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
} from '@/lib/whatsapp/broadcast-core';

// ============================================================
// POST /api/v1/broadcasts
//
// Esta rota aceita DOIS tipos de autenticação:
//
// 1. WACRM interno:
//    sessão Supabase do usuário logado.
//
// 2. Public API:
//    Authorization: Bearer wacrm_live_...
//
// O frontend /broadcasts/new NÃO precisa conhecer nenhuma
// API key.
//
// O envio continua sendo feito pelo broadcast-core.
//
// Fluxo:
//
//   WACRM
//      ↓
//   sessão Supabase
//      ↓
//   createBroadcast()
//      ↓
//   broadcasts + broadcast_recipients
//      ↓
//   after()
//      ↓
//   deliverBroadcast()
//      ↓
//   Meta
//      ↓
//   messages
//      ↓
//   Inbox
//
// ============================================================

export const maxDuration = 60;

/**
 * Contexto de autenticação aceito pela rota.
 */
type BroadcastAuthContext = {
  supabase: Awaited<
    ReturnType<typeof getCurrentAccount>
  >['supabase'];

  accountId: string;

  userId: string;

  authType: 'session' | 'api_key';
};

/**
 * Resolve a autenticação da requisição.
 *
 * Se existir Authorization: Bearer wacrm_live_...,
 * usa a Public API normalmente.
 *
 * Caso contrário, usa a sessão normal do WACRM.
 *
 * IMPORTANTE:
 * A API key nunca é colocada no frontend.
 */
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
        .catch(() => null)) as Record<
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
    // Extract request data
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
    // Validate recipient structure
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
    // Create persistent broadcast plan
    //
    // NÃO envia nada para a Meta nesta etapa.
    //
    // createBroadcast():
    //
    //   broadcasts
    //   +
    //   broadcast_recipients
    //   +
    //   template_params
    //
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
    // Start asynchronous delivery
    // ----------------------------------------------------------

    after(() =>
      deliverBroadcast(
        ctx.supabase,
        plan,
      ).catch(
        (error) => {
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
        },
      ),
    );

    // ----------------------------------------------------------
    // Return immediately
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
    // Session authentication errors
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
    // Public API errors / unknown errors
    // ----------------------------------------------------------

    return toApiErrorResponse(
      err,
    );
  }
}