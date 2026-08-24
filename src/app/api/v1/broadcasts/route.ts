import { after } from 'next/server';

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
// Launch a template broadcast.
//
// Body:
// {
//   "name": "July promo",
//   "template_name": "promo_july",
//   "template_language": "en_US",
//   "recipients": [
//     {
//       "to": "+14155550123",
//       "params": ["Jane"]
//     },
//     {
//       "to": "+14155550124"
//     }
//   ]
// }
//
// The broadcast + recipient rows are persisted synchronously.
//
// Meta fan-out runs through after() so the HTTP request returns
// immediately after the broadcast plan has been persisted.
//
// Poll:
// GET /api/v1/broadcasts/{id}
// ============================================================

export const maxDuration = 60;

export async function POST(
  request: Request
) {
  try {
    // ----------------------------------------------------------
    // API authentication
    // ----------------------------------------------------------

    const ctx =
      await requireApiKey(
        request,
        'broadcasts:send'
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
        400
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
        body.recipients
      )
        ? body.recipients
        : [];

    // ----------------------------------------------------------
    // Resolve audit user
    // ----------------------------------------------------------

    const auditUserId =
      await resolveAuditUserId(
        ctx.supabase,
        ctx.accountId
      );

    // ----------------------------------------------------------
    // Create persistent broadcast plan
    //
    // IMPORTANT:
    // No Meta message is sent by createBroadcast().
    //
    // The broadcast and recipient rows are created atomically.
    // ----------------------------------------------------------

    const plan =
      await createBroadcast(
        ctx.supabase,
        ctx.accountId,
        auditUserId,
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
            recipients.map(
              (r) => ({
                to:
                  typeof r?.to ===
                  'string'
                    ? r.to
                    : '',

                params:
                  Array.isArray(
                    r?.params
                  )
                    ? r.params
                    : undefined,
              })
            ),

          headerMediaUrl:
            typeof body.header_media_url ===
            'string'
              ? body.header_media_url
              : null,
        }
      );

    // ----------------------------------------------------------
    // Start asynchronous Meta delivery
    //
    // The same Supabase client is used because delivery needs
    // the account-scoped database context created above.
    //
    // No new WhatsApp integration is created here.
    // ----------------------------------------------------------

    after(() =>
      deliverBroadcast(
        ctx.supabase,
        plan
      )
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
      202
    );
  } catch (err) {
    // ----------------------------------------------------------
    // Known broadcast errors
    // ----------------------------------------------------------

    if (
      err instanceof BroadcastError
    ) {
      return fail(
        err.code,
        err.message,
        err.status
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
        err.status
      );
    }

    // ----------------------------------------------------------
    // Unknown errors
    // ----------------------------------------------------------

    return toApiErrorResponse(
      err
    );
  }
}