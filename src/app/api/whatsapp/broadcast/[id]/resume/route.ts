// ============================================================
// POST /api/whatsapp/broadcast/[id]/resume
//
// Resumes pending recipients or retries failed recipients.
//
// The request only claims and plans the delivery.
// The actual fan-out runs inside after().
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
  }
) {
  let claimedId:
    | string
    | null = null;

  try {
    // --------------------------------------------------------
    // Authentication / authorization
    // --------------------------------------------------------

    const {
      supabase,
      accountId,
      userId,
    } = await requireRole('agent');

    // --------------------------------------------------------
    // Rate limit
    // --------------------------------------------------------

    const limit =
      checkRateLimit(
        `broadcast-resume:${userId}`,
        RATE_LIMITS.broadcast
      );

    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    // --------------------------------------------------------
    // Route params
    // --------------------------------------------------------

    const { id } = await params;

    // --------------------------------------------------------
    // Request body
    // --------------------------------------------------------

    const body =
      await request
        .json()
        .catch(() => ({}));

    const requestedScope =
      body?.scope;

    const scope: ResumeScope =
      RESUME_SCOPES.includes(
        requestedScope
      )
        ? requestedScope
        : 'pending';

    // --------------------------------------------------------
    // Claim delivery lock
    //
    // Prevents two Resume requests from selecting the same
    // pending recipients and sending them twice.
    // --------------------------------------------------------

    const claimed =
      await claimBroadcastDelivery(
        supabase,
        accountId,
        id
      );

    if (!claimed) {
      return NextResponse.json(
        {
          error:
            'A delivery pass is already running for this broadcast. Wait for it to finish before resuming again.',
        },
        {
          status: 409,
        }
      );
    }

    claimedId = id;

    // --------------------------------------------------------
    // Build plan
    //
    // IMPORTANT:
    // auditUserId is required by BroadcastPlan.
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
        scope
      );

    // --------------------------------------------------------
    // Mark campaign as sending
    // --------------------------------------------------------

    await markBroadcastSending(
      supabase,
      id
    );

    // The after() callback now owns the lock.
    claimedId = null;

    // --------------------------------------------------------
    // Service-role client
    //
    // The actual delivery happens after the response has been
    // scheduled, using the admin client.
    // --------------------------------------------------------

    const admin =
      supabaseAdmin();

    after(async () => {
      try {
        await deliverBroadcast(
          admin,
          plan
        );
      } catch (error) {
        console.error(
          '[broadcast-resume] delivery threw:',
          error instanceof Error
            ? error.message
            : error
        );

        // If the delivery loop itself throws, derive the final
        // state from the recipient rows instead of trusting a
        // local counter.
        await finalizeBroadcastStatus(
          admin,
          id
        ).catch(() => {});
      } finally {
        await releaseBroadcastDelivery(
          admin,
          id
        );
      }
    });

    // --------------------------------------------------------
    // Return immediately
    // --------------------------------------------------------

    return NextResponse.json(
      {
        success: true,

        broadcast_id: id,

        scope,

        resuming:
          plan.planned.length,

        remaining,

        unsendable,
      },
      {
        status: 202,
      }
    );
  } catch (error) {
    // --------------------------------------------------------
    // Planning failed after acquiring the lock.
    //
    // Release it immediately instead of waiting for the
    // 30-minute stale-lock timeout.
    // --------------------------------------------------------

    if (claimedId) {
      await releaseBroadcastDelivery(
        supabaseAdmin(),
        claimedId
      ).catch(() => {});
    }

    // --------------------------------------------------------
    // Known application error
    // --------------------------------------------------------

    if (
      error instanceof BroadcastError
    ) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
        },
        {
          status: error.status,
        }
      );
    }

    // --------------------------------------------------------
    // Unknown error
    // --------------------------------------------------------

    console.error(
      'Error in broadcast resume POST:',
      error
    );

    return toErrorResponse(
      error
    );
  }
}