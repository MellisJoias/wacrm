import { after } from 'next/server';
import { NextResponse } from 'next/server';

import {
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';

import {
  BroadcastError,
  deliverBroadcast,
  finalizeBroadcastStatus,
} from '@/lib/whatsapp/broadcast-core';

import {
  claimBroadcastDelivery,
  markBroadcastSending,
  planBroadcastResume,
  releaseBroadcastDelivery,
  RESUME_SCOPES,
  type ResumeScope,
} from '@/lib/whatsapp/broadcast-resume';

import { supabaseAdmin } from '@/lib/flows/admin-client';

import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

// ============================================================
// POST /api/whatsapp/broadcast/[id]/resume
//
// Resume automático ou manual.
//
// O endpoint trabalha em PASS.
//
// Exemplo:
//
//   1000 recipients
//
//   PASS 1 -> 50
//   PASS 2 -> 50
//   PASS 3 -> 50
//   ...
//
// Cada recipient dentro do pass continua sendo enviado
// estritamente um por vez.
// ============================================================

export const maxDuration = 300;

// ============================================================
// Internal continuation authentication
// ============================================================
//
// O próprio servidor chama este endpoint para continuar uma
// campanha.
//
// Não usamos sessão do navegador para isso.
//
// Configure na Vercel:
//
// BROADCAST_INTERNAL_SECRET=um_valor_longo_e_aleatorio
// ============================================================

function isInternalRequest(
  request: Request,
): boolean {
  const configuredSecret =
    process.env
      .BROADCAST_INTERNAL_SECRET;

  if (
    !configuredSecret ||
    configuredSecret.length === 0
  ) {
    return false;
  }

  const suppliedSecret =
    request.headers.get(
      'x-broadcast-internal-secret',
    );

  return (
    !!suppliedSecret &&
    suppliedSecret ===
      configuredSecret
  );
}

// ============================================================
// Internal resume trigger
// ============================================================
//
// Chamado pelo próprio servidor quando ainda existem pending.
//
// Usa fetch contra a própria aplicação.
// ============================================================

async function triggerNextPass(
  request: Request,
  broadcastId: string,
): Promise<void> {
  const secret =
    process.env
      .BROADCAST_INTERNAL_SECRET;

  if (!secret) {
    console.error(
      '[broadcast-resume] BROADCAST_INTERNAL_SECRET is not configured. Automatic continuation cannot run.',
    );

    return;
  }

  const origin =
    new URL(request.url).origin;

  const url =
    `${origin}/api/whatsapp/broadcast/${encodeURIComponent(
      broadcastId,
    )}/resume`;

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

          cache: 'no-store',
        },
      );

    const text =
      await response
        .text()
        .catch(() => '');

    if (!response.ok) {
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

// ============================================================
// POST
// ============================================================

export async function POST(
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      id: string;
    }>;
  },
) {
  let claimedId:
    | string
    | null = null;

  const internal =
    isInternalRequest(
      request,
    );

  try {
    // --------------------------------------------------------
    // Authentication
    // --------------------------------------------------------

    let supabase:
      Awaited<
        ReturnType<typeof requireRole>
      >['supabase'];

    let accountId: string;
    let userId: string;

    if (internal) {
      // ------------------------------------------------------
      // Internal server continuation
      //
      // We intentionally use service-role here because the
      // request originated from our own server.
      // ------------------------------------------------------

      const admin =
        supabaseAdmin();

      supabase =
        admin;

      const { id } =
        await params;

      const {
        data: broadcast,
        error,
      } = await admin
        .from('broadcasts')
        .select(
          'account_id, created_by',
        )
        .eq(
          'id',
          id,
        )
        .maybeSingle();

      if (
        error ||
        !broadcast
      ) {
        return NextResponse.json(
          {
            error:
              'Broadcast not found',
          },
          {
            status: 404,
          },
        );
      }

      accountId =
        broadcast.account_id;

      userId =
        broadcast.created_by;
    } else {
      // ------------------------------------------------------
      // Normal WACRM request
      // ------------------------------------------------------

      const ctx =
        await requireRole(
          'agent',
        );

      supabase =
        ctx.supabase;

      accountId =
        ctx.accountId;

      userId =
        ctx.userId;

      const limit =
        checkRateLimit(
          `broadcast-resume:${userId}`,
          RATE_LIMITS.broadcast,
        );

      if (!limit.success) {
        return rateLimitResponse(
          limit,
        );
      }
    }

    // --------------------------------------------------------
    // Route params
    // --------------------------------------------------------

    const { id } =
      await params;

    // --------------------------------------------------------
    // Request body
    // --------------------------------------------------------

    const body =
      await request
        .json()
        .catch(
          () => ({}),
        );

    const requestedScope =
      body?.scope;

    const scope: ResumeScope =
      RESUME_SCOPES.includes(
        requestedScope,
      )
        ? requestedScope
        : 'pending';

    // --------------------------------------------------------
    // Claim delivery lock
    // --------------------------------------------------------

    const claimed =
      await claimBroadcastDelivery(
        supabase,
        accountId,
        id,
      );

    if (!claimed) {
      return NextResponse.json(
        {
          error:
            'A delivery pass is already running for this broadcast. Wait for it to finish before resuming again.',
        },
        {
          status: 409,
        },
      );
    }

    claimedId =
      id;

    // --------------------------------------------------------
    // Build resume plan
    // --------------------------------------------------------

    const {
      plan,
      remaining,
      unsendable,
    } =
      await planBroadcastResume(
        supabase,
        accountId,
        userId,
        id,
        scope,
      );

    // --------------------------------------------------------
    // Mark campaign as sending
    // --------------------------------------------------------

    await markBroadcastSending(
      supabase,
      id,
    );

    // --------------------------------------------------------
    // after() owns the delivery lock
    // --------------------------------------------------------

    claimedId =
      null;

    const admin =
      supabaseAdmin();

    after(async () => {
      let shouldContinue =
        false;

      try {
        console.log(
          '[broadcast-resume] starting delivery pass:',
          {
            broadcastId:
              id,

            scope,

            passSize:
              plan.planned.length,

            remainingBeforePass:
              remaining,

            internal,
          },
        );

        await deliverBroadcast(
          admin,
          plan,
        );

        // ----------------------------------------------------
        // Determine whether pending recipients remain.
        //
        // finalizeBroadcastStatus() leaves the campaign as
        // "sending" while pending rows exist.
        // ----------------------------------------------------

        const {
          count: pendingCount,
          error: pendingError,
        } = await admin
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
            id,
          )
          .eq(
            'status',
            'pending',
          );

        if (pendingError) {
          console.error(
            '[broadcast-resume] failed checking pending recipients:',
            pendingError,
          );
        } else {
          shouldContinue =
            (pendingCount ?? 0) > 0;

          console.log(
            '[broadcast-resume] pass completed:',
            {
              broadcastId:
                id,

              pending:
                pendingCount ?? 0,

              shouldContinue,
            },
          );
        }
      } catch (error) {
        console.error(
          '[broadcast-resume] delivery threw:',
          error instanceof Error
            ? error.message
            : error,
        );

        await finalizeBroadcastStatus(
          admin,
          id,
        ).catch(() => {});
      } finally {
        // ------------------------------------------------------
        // Release current pass lock first.
        // ------------------------------------------------------

        await releaseBroadcastDelivery(
          admin,
          id,
        );

        // ------------------------------------------------------
        // If pending remain, immediately schedule the next pass.
        //
        // This happens AFTER releasing the lock, otherwise the
        // next request could receive HTTP 409.
        // ------------------------------------------------------

        if (
          shouldContinue
        ) {
          await triggerNextPass(
            request,
            id,
          );
        }
      }
    });

    // --------------------------------------------------------
    // Return immediately
    // --------------------------------------------------------

    return NextResponse.json(
      {
        success: true,

        broadcast_id:
          id,

        scope,

        resuming:
          plan.planned.length,

        remaining,

        unsendable,

        automatic_continuation:
          true,
      },
      {
        status: 202,
      },
    );
  } catch (error) {
    // --------------------------------------------------------
    // Release lock if planning failed
    // --------------------------------------------------------

    if (claimedId) {
      await releaseBroadcastDelivery(
        supabaseAdmin(),
        claimedId,
      ).catch(() => {});
    }

    // --------------------------------------------------------
    // Known error
    // --------------------------------------------------------

    if (
      error instanceof BroadcastError
    ) {
      return NextResponse.json(
        {
          error:
            error.message,

          code:
            error.code,
        },
        {
          status:
            error.status,
        },
      );
    }

    // --------------------------------------------------------
    // Unknown
    // --------------------------------------------------------

    console.error(
      'Error in broadcast resume POST:',
      error,
    );

    return toErrorResponse(
      error,
    );
  }
}