"use client";

import { cn } from "@/lib/utils";
import type { Message, MessageReaction } from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  MapPin,
  LayoutTemplate,
  CornerDownLeft,
  Sparkles,
  UserRound,
  Phone,
  Mail,
  Building2,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import {
  MediaAudioBubble,
  MediaDocumentBubble,
  MediaImageBubble,
  MediaUnavailable,
  MediaVideoBubble,
} from "./message-media";
import { InteractivePreview } from "@/components/interactive/interactive-preview";
import { useTranslations } from "next-intl";

interface MessageBubbleProps {
  message: Message;
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  onOpenMedia?: (messageId: string) => void;
}

function StatusIcon({ status }: { status: Message["status"] }) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;

    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;

    case "delivered":
      return (
        <CheckCheck className="h-3 w-3 text-muted-foreground" />
      );

    case "read":
      return (
        <CheckCheck className="h-3 w-3 text-blue-400" />
      );

    case "failed":
      return (
        <XCircle className="h-3 w-3 text-red-400" />
      );

    default:
      return null;
  }
}

function ContactCard({
  message,
}: {
  message: Message;
}) {
  const payload = message.contact_payload;

  if (!payload) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <UserRound className="h-5 w-5 shrink-0" />

        <span>
          {message.content_text || "Contato compartilhado"}
        </span>
      </div>
    );
  }

  const name =
    payload.name?.formatted_name ||
    [payload.name?.first_name, payload.name?.last_name]
      .filter(Boolean)
      .join(" ") ||
    message.content_text ||
    "Contato";

  const phone = payload.phones?.[0]?.phone;
  const email = payload.emails?.[0]?.email;
  const company = payload.org?.company;
  const title = payload.org?.title;

  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <div className="w-[280px] max-w-full overflow-hidden rounded-xl border border-border bg-background text-foreground">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <span className="text-sm font-semibold">
            {initials || "C"}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {name}
          </p>

          {title && (
            <p className="truncate text-xs text-muted-foreground">
              {title}
            </p>
          )}

          {company && (
            <p className="truncate text-xs text-muted-foreground">
              {company}
            </p>
          )}
        </div>
      </div>

      <div className="px-4 py-3">
        <div className="space-y-3">
          {phone && (
            <div className="flex items-start gap-2">
              <Phone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />

              <div className="min-w-0">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Telefone
                </p>

                <p className="break-all text-sm">
                  {phone}
                </p>
              </div>
            </div>
          )}

          {email && (
            <div className="flex items-start gap-2">
              <Mail className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />

              <div className="min-w-0">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  E-mail
                </p>

                <p className="break-all text-sm">
                  {email}
                </p>
              </div>
            </div>
          )}

          {company && (
            <div className="flex items-start gap-2">
              <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />

              <div className="min-w-0">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Empresa
                </p>

                <p className="break-words text-sm">
                  {company}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border px-4 py-2">
        <span className="text-[10px] text-muted-foreground">
          Contato compartilhado pelo WhatsApp
        </span>
      </div>
    </div>
  );
}

function MessageContent({
  message,
  t,
  isAgent,
  onOpenMedia,
}: {
  message: Message;
  t: ReturnType<typeof useTranslations>;
  isAgent: boolean;
  onOpenMedia?: (messageId: string) => void;
}) {
  const openMedia = onOpenMedia
    ? () => onOpenMedia(message.id)
    : undefined;

  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text}
        </p>
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImageBubble
              message={message}
              onOpen={openMedia}
              t={t}
            />
          ) : (
            <MediaUnavailable
              label={t("photo")}
              t={t}
            />
          )}

          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <MediaVideoBubble
              message={message}
              onOpen={openMedia}
              t={t}
            />
          ) : (
            <MediaUnavailable
              label={t("video")}
              t={t}
            />
          )}

          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "audio":
      return (
        <div>
          {message.media_url ? (
            <MediaAudioBubble
              message={message}
              t={t}
            />
          ) : (
            <MediaUnavailable
              label={t("audio")}
              t={t}
            />
          )}
        </div>
      );

    case "document":
      if (!message.media_url) {
        return (
          <MediaUnavailable
            label={
              message.content_text ||
              t("document")
            }
            t={t}
          />
        );
      }

      return (
        <MediaDocumentBubble
          message={message}
          t={t}
        />
      );

    case "template":
      return (
        <div>
          <span
            className={cn(
              "mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
              isAgent
                ? "bg-primary-foreground/20 text-primary-foreground"
                : "bg-primary/20 text-primary",
            )}
          >
            <LayoutTemplate className="h-3 w-3" />

            {t("template")}
          </span>

          {message.content_text ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          ) : (
            message.template_name && (
              <p className="mt-1 break-words text-sm italic opacity-80">
                {message.template_name}
              </p>
            )
          )}
        </div>
      );

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />

          <span>
            {message.content_text ||
              t("locationShared")}
          </span>
        </div>
      );

    case "contact":
    case "contacts":
      return (
        <ContactCard message={message} />
      );

    case "interactive": {
      if (message.interactive_payload) {
        return (
          <InteractivePreview
            payload={message.interactive_payload}
          />
        );
      }

      if (message.sender_type === "customer") {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <CornerDownLeft className="h-3 w-3" />

              {t("buttonReply")}
            </span>

            <p className="whitespace-pre-wrap break-words text-sm">
              {message.content_text ||
                t("interactiveReply")}
            </p>
          </div>
        );
      }

      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text ||
            t("interactiveReply")}
        </p>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text ||
            t("unsupported")}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  onOpenMedia,
}: MessageBubbleProps) {
  const t = useTranslations("Inbox.bubble");

  const isAgent =
    message.sender_type === "agent" ||
    message.sender_type === "bot";

  const time = format(
    new Date(message.created_at),
    "HH:mm",
  );

  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent
          ? "items-end"
          : "items-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-2xl px-3 py-2",
          isAgent
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-muted text-foreground",
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}

        <MessageContent
          message={message}
          t={t}
          isAgent={isAgent}
          onOpenMedia={onOpenMedia}
        />

        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isAgent
              ? "justify-end"
              : "justify-start",
          )}
        >
          {message.ai_generated && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-primary-foreground/20 px-1.5 py-px text-[9px] font-semibold uppercase leading-none tracking-wide text-primary-foreground"
              title={t("aiBadgeTitle")}
            >
              <Sparkles className="h-2.5 w-2.5" />

              {t("aiBadge")}
            </span>
          )}

          <span
            className={cn(
              "text-[10px]",
              isAgent
                ? "text-primary-foreground/70"
                : "text-muted-foreground",
            )}
          >
            {time}
          </span>

          {isAgent && (
            <StatusIcon
              status={message.status}
            />
          )}
        </div>
      </div>

      {reactions &&
        reactions.length > 0 &&
        onToggleReaction && (
          <MessageReactions
            reactions={reactions}
            currentUserId={currentUserId}
            onToggle={onToggleReaction}
          />
        )}
    </div>
  );
}