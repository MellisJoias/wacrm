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
// Quando o lote termina e ainda existem pending,
// o próprio delivery agenda automaticamente o próximo pass.
// ============================================================

export const maxDuration = 300;

type BroadcastAuthContext = {
  supabase: Awaited<
    ReturnType<typeof getCurrentAccount>
  >['supabase'];

  accountId: string;

  userId: string;

  authType: 'session' | 'api_key';
};

// ============================================================
// Authentication
// ============================================================

async function resolveBroadcastAuth(
  request: Request,
): Promise<BroadcastAuthContext> {
  const authorization =
    request.headers.get('authorization');

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
    // IMPORTANTE
    //
    // O broadcast pode conter centenas de recipients.
    //
    // Não enviamos todos dentro de uma única execução.
    //
    // O primeiro pass recebe somente o tamanho definido no
    // broadcast-core.ts.
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