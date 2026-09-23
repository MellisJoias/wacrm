// ============================================================
// POST /api/whatsapp/broadcast/[id]/resume
//
// Resumes pending recipients or retries failed recipients.
//
// The request only claims and plans the delivery.
// The actual fan-out runs inside after().
//
// AUTOMATIC CONTINUATION:
//
// After each batch finishes:
//
//   12 recipients
//        ↓
//   release lock
//        ↓
//   wait exactly 20 seconds
//        ↓
//   internal POST to this same endpoint
//        ↓
//   next 12 recipients
//
// The internal request uses BROADCAST_INTERNAL_SECRET.
// No browser click is required.
// No Meta integration is changed.
// ============================================================

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
// Next.js function timeout
// ============================================================

export const maxDuration = 300;

// ============================================================
// Automatic batch delay
// ============================================================

const BROADCAST_BATCH_DELAY_MS =
  20_000;

// ============================================================
// Internal request
// ============================================================
//
// The browser does not have to click Resume.
//
// The backend calls this same endpoint using the secret.
// ============================================================

function isInternalRequest(
  request: Request,
): boolean {
  const configuredSecret =
    process.env.BROADCAST_INTERNAL_SECRET;

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
// Wait exactly 20 seconds between batches
// ============================================================

async function waitBetweenBroadcastBatches(): Promise<void> {
  console.log(
    '[broadcast-resume] WAITING BETWEEN BATCHES',
    {
      delayMs:
        BROADCAST_BATCH_DELAY_MS,

      delaySeconds:
        BROADCAST_BATCH_DELAY_MS / 1000,
    },
  );

  await new Promise<void>(
    (resolve) => {
      setTimeout(
        resolve,
        BROADCAST_BATCH_DELAY_MS,
      );
    },
  );

  console.log(
    '[broadcast-resume] BATCH DELAY FINISHED',
  );
}

// ============================================================
// Trigger next batch
// ============================================================
//
// This is NOT a browser click.
//
// It is an internal backend request.
//
// ============================================================

async function triggerNextBatch(
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

  // ----------------------------------------------------------
  // Wait exactly 20 seconds after the current batch.
  // ----------------------------------------------------------

  await waitBetweenBroadcastBatches();

  const origin =
    new URL(request.url).origin;

  const url =
    `${origin}/api/whatsapp/broadcast/${encodeURIComponent(
      broadcastId,
    )}/resume`;

  try {
    console.log(
      '[broadcast-resume] triggering next delivery batch:',
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

    const responseText =
      await response
        .text()
        .catch(
          () => '',
        );

    if (
      !response.ok
    ) {
      console.error(
        '[broadcast-resume] next batch returned non-2xx:',
        {
          broadcastId,

          status:
            response.status,

          body:
            responseText,
        },
      );

      return;
    }

    console.log(
      '[broadcast-resume] next delivery batch accepted:',
      {
        broadcastId,

        status:
          response.status,

        body:
          responseText,
      },
    );
  } catch (error) {
    console.error(
      '[broadcast-resume] failed to trigger next batch:',
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
    // Route params
    // --------------------------------------------------------

    const { id } =
      await params;

    // --------------------------------------------------------
    // Authentication
    // --------------------------------------------------------
    //
    // Normal request:
    //   authenticated WACRM user
    //
    // Automatic request:
    //   BROADCAST_INTERNAL_SECRET
    // --------------------------------------------------------

    let supabase:
      ReturnType<typeof supabaseAdmin>;

    let accountId: string;

    let userId: string;

    if (internal) {
      // ======================================================
      // INTERNAL AUTOMATIC CONTINUATION
      // ======================================================

      console.log(
        '[broadcast-resume] INTERNAL AUTOMATIC REQUEST',
        {
          broadcastId:
            id,
        },
      );

      const admin =
        supabaseAdmin();

      // ------------------------------------------------------
      // Find the broadcast so we know which account owns it.
      // ------------------------------------------------------

      const {
        data: broadcast,
        error:
          broadcastError,
      } =
        await admin
          .from('broadcasts')
          .select(
            'id, account_id, created_by',
          )
          .eq(
            'id',
            id,
          )
          .maybeSingle();

      if (
        broadcastError
      ) {
        console.error(
          '[broadcast-resume] internal broadcast lookup failed:',
          broadcastError.message,
        );

        return NextResponse.json(
          {
            error:
              'Failed to load broadcast',
          },
          {
            status:
              500,
          },
        );
      }

      if (
        !broadcast
      ) {
        return NextResponse.json(
          {
            error:
              'Broadcast not found',
          },
          {
            status:
              404,
          },
        );
      }

      supabase =
        admin;

      accountId =
        broadcast.account_id;

      userId =
        broadcast.created_by;
    } else {
      // ======================================================
      // NORMAL USER REQUEST
      // ======================================================

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

      // ------------------------------------------------------
      // Rate limit only applies to browser/user requests.
      // Internal continuation is server-to-server.
      // ------------------------------------------------------

      const limit =
        checkRateLimit(
          `broadcast-resume:${userId}`,
          RATE_LIMITS.broadcast,
        );

      if (
        !limit.success
      ) {
        return rateLimitResponse(
          limit,
        );
      }
    }

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
    //
    // Prevents two delivery passes from running simultaneously.
    // --------------------------------------------------------

    const claimed =
      await claimBroadcastDelivery(
        supabase,
        accountId,
        id,
      );

    if (!claimed) {
      console.log(
        '[broadcast-resume] delivery lock already claimed:',
        {
          broadcastId:
            id,

          internal,
        },
      );

      return NextResponse.json(
        {
          error:
            'A delivery pass is already running for this broadcast. Wait for it to finish before resuming again.',
        },
        {
          status:
            409,
        },
      );
    }

    claimedId =
      id;

    // --------------------------------------------------------
    // Build delivery plan
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
    // after() now owns the lock.
    // --------------------------------------------------------

    claimedId =
      null;

    const admin =
      supabaseAdmin();

    // ========================================================
    // BACKGROUND DELIVERY
    // ========================================================

    after(async () => {
      let shouldContinue =
        false;

      try {
        console.log(
          '[broadcast-resume] STARTING DELIVERY BATCH',
          {
            broadcastId:
              id,

            scope,

            batchSize:
              plan.planned.length,

            remainingBefore:
              remaining,

            internal,
          },
        );

        // ----------------------------------------------------
        // Send this batch.
        //
        // broadcast-core.ts handles the random 10-20 second
        // interval between individual recipients.
        // ----------------------------------------------------

        await deliverBroadcast(
          admin,
          plan,
        );

        console.log(
          '[broadcast-resume] DELIVERY BATCH FINISHED',
          {
            broadcastId:
              id,

            batchSize:
              plan.planned.length,
          },
        );

        // ----------------------------------------------------
        // Check remaining pending recipients.
        // ----------------------------------------------------

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
              id,
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
            {
              broadcastId:
                id,

              error:
                pendingError,
            },
          );
        } else {
          shouldContinue =
            (pendingCount ?? 0) > 0;

          console.log(
            '[broadcast-resume] PENDING CHECK',
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
        ).catch(
          () => {},
        );
      } finally {
        // ----------------------------------------------------
        // Release current delivery lock.
        // ----------------------------------------------------

        await releaseBroadcastDelivery(
          admin,
          id,
        );

        console.log(
          '[broadcast-resume] CURRENT BATCH LOCK RELEASED',
          {
            broadcastId:
              id,
          },
        );

        // ----------------------------------------------------
        // Automatic continuation.
        // ----------------------------------------------------

        if (
          shouldContinue
        ) {
          console.log(
            '[broadcast-resume] PENDING RECIPIENTS REMAIN',
            {
              broadcastId:
                id,

              action:
                'automatic_continuation',
            },
          );

          await triggerNextBatch(
            request,
            id,
          );
        } else {
          console.log(
            '[broadcast-resume] NO PENDING RECIPIENTS REMAIN',
            {
              broadcastId:
                id,

              action:
                'broadcast_finished',
            },
          );
        }
      }
    });

    // --------------------------------------------------------
    // Return immediately.
    // --------------------------------------------------------

    return NextResponse.json(
      {
        success:
          true,

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
        status:
          202,
      },
    );
  } catch (error) {
    // --------------------------------------------------------
    // Release lock if planning failed after claiming it.
    // --------------------------------------------------------

    if (
      claimedId
    ) {
      await releaseBroadcastDelivery(
        supabaseAdmin(),
        claimedId,
      ).catch(
        () => {},
      );
    }

    // --------------------------------------------------------
    // Known application error
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
    // Unknown error
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