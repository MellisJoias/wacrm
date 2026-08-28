"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { usePresence } from "@/hooks/use-presence";
import { PresenceDot } from "@/components/presence/presence-dot";
import { presenceLabel } from "@/lib/presence";
import { cn } from "@/lib/utils";
import type {
  Conversation,
  Message,
  MessageReaction,
  Contact,
  ConversationStatus,
  MessageTemplate,
  Profile,
  InteractiveMessagePayload,
} from "@/types";
import {
  MessageSquare,
  ChevronDown,
  UserPlus,
  Check,
  Clock,
  ArrowLeft,
  RefreshCw,
  PanelRightOpen,
  PanelRightClose,
} from "lucide-react";
import { format, isToday, isYesterday, differenceInHours } from "date-fns";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MessageBubble } from "./message-bubble";
import { MessageActions } from "./message-actions";
import { MediaLightbox } from "./media-lightbox";
import { collectMediaGallery } from "@/lib/media/gallery";
import {
  MessageComposer,
  CHAT_MEDIA_BUCKET,
  type SendMediaPayload,
} from "./message-composer";
import { deleteAccountMedia } from "@/lib/storage/upload-media";
import { TemplatePicker } from "./template-picker";
import { AiThreadBanner } from "./ai-thread-banner";
import { buildReplyPreview } from "./reply-quote";
import { renderTemplateBody } from "@/lib/whatsapp/template-body";
import { toast } from "sonner";

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
  messages: Message[];
  onMessagesLoaded: (messages: Message[]) => void;
  onNewMessage: (message: Message) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
  onStatusChange: (conversationId: string, status: ConversationStatus) => void;
  onAssignChange: (
    conversationId: string,
    assignedAgentId: string | null,
  ) => void;
  onBack?: () => void;
  resyncToken?: number;
  onRefresh?: () => void;
  contactPanelOpen?: boolean;
  onToggleContactPanel?: () => void;
}

function formatDateSeparator(
  dateStr: string,
  t: ReturnType<typeof useTranslations>,
): string {
  const date = new Date(dateStr);
  if (isToday(date)) return t("today");
  if (isYesterday(date)) return t("yesterday");
  return format(date, "MMMM d, yyyy");
}

function groupMessagesByDate(messages: Message[]) {
  const groups: { date: string; messages: Message[] }[] = [];
  let currentDate = "";

  for (const msg of messages) {
    const day = format(new Date(msg.created_at), "yyyy-MM-dd");

    if (day !== currentDate) {
      currentDate = day;
      groups.push({
        date: msg.created_at,
        messages: [msg],
      });
    } else {
      groups[groups.length - 1].messages.push(msg);
    }
  }

  return groups;
}

const STATUS_OPTIONS: {
  label: string;
  value: ConversationStatus;
  color: string;
}[] = [
  { label: "Open", value: "open", color: "text-primary" },
  { label: "Pending", value: "pending", color: "text-amber-400" },
  {
    label: "Closed",
    value: "closed",
    color: "text-muted-foreground",
  },
];

const DOODLE_BG_CLASSES =
  "bg-background bg-[url('/inbox-doodle.svg')] bg-repeat";

export function MessageThread({
  conversation,
  contact,
  messages,
  onMessagesLoaded,
  onNewMessage,
  onUpdateMessage,
  onStatusChange,
  onAssignChange,
  onBack,
  resyncToken = 0,
  onRefresh,
  contactPanelOpen,
  onToggleContactPanel,
}: MessageThreadProps) {
  const t = useTranslations("Inbox.messageThread");
  const tTimer = useTranslations("Inbox.sessionTimer");
  const tQuote = useTranslations("Inbox.replyQuote");

  const { user } = useAuth();
  const { getPresence, getRow, now } = usePresence();

  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [reactions, setReactions] = useState<MessageReaction[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  const handleRefreshClick = useCallback(() => {
    if (isRefreshing || !onRefresh) return;

    setIsRefreshing(true);
    onRefresh();

    refreshTimerRef.current = setTimeout(() => {
      setIsRefreshing(false);
      refreshTimerRef.current = null;
    }, 700);
  }, [isRefreshing, onRefresh]);

  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);

  const [openMedia, setOpenMedia] = useState<{
    conversationId: string;
    messageId: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const supabase = createClient();

    supabase
      .from("profiles")
      .select("*")
      .order("full_name")
      .then(({ data, error }) => {
        if (cancelled) return;

        if (error) {
          console.error("Failed to fetch profiles:", error);
          return;
        }

        setProfiles((data as Profile[]) ?? []);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const sessionInfo = useMemo(() => {
    if (!messages.length) {
      return {
        expired: false,
        remaining: "",
      };
    }

    const lastCustomerMsg = [...messages]
      .reverse()
      .find((m) => m.sender_type === "customer");

    if (!lastCustomerMsg) {
      return {
        expired: true,
        remaining: "No customer messages",
      };
    }

    const hoursSince = differenceInHours(
      new Date(),
      new Date(lastCustomerMsg.created_at),
    );

    const expired = hoursSince >= 24;

    if (expired) {
      return {
        expired: true,
        remaining: tTimer("expired"),
      };
    }

    const hoursLeft = 24 - hoursSince;

    const remaining =
      hoursLeft >= 1
        ? tTimer("xhRemaining", {
            hours: Math.floor(hoursLeft),
          })
        : tTimer("xmRemaining", {
            minutes: Math.floor(hoursLeft * 60),
          });

    return {
      expired,
      remaining,
    };
  }, [messages, tTimer]);

  const onMessagesLoadedRef = useRef(onMessagesLoaded);

  useEffect(() => {
    onMessagesLoadedRef.current = onMessagesLoaded;
  });

  const conversationId = conversation?.id;
  const hasUnread = (conversation?.unread_count ?? 0) > 0;

  const mediaMessageId =
    openMedia && openMedia.conversationId === conversationId
      ? openMedia.messageId
      : null;

  const handleMediaChange = useCallback(
    (messageId: string | null) => {
      setOpenMedia(
        messageId && conversationId
          ? {
              conversationId,
              messageId,
            }
          : null,
      );
    },
    [conversationId],
  );

  useEffect(() => {
    if (!conversationId) return;

    const supabase = createClient();
    let cancelled = false;

    (async () => {
      setLoading(true);

      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", {
          ascending: true,
        });

      if (cancelled) return;

      if (error) {
        console.error("Failed to fetch messages:", error);
      } else {
        onMessagesLoadedRef.current(data ?? []);
      }

      if (!cancelled) {
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, resyncToken]);

  useEffect(() => {
    if (!conversationId) {
      setReactions([]);
      return;
    }

    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("message_reactions")
        .select("*")
        .eq("conversation_id", conversationId);

      if (cancelled) return;

      if (error) {
        console.error("Failed to fetch reactions:", error);
        return;
      }

      setReactions((data as MessageReaction[]) ?? []);
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, resyncToken]);

  useEffect(() => {
    if (!conversationId) return;

    const supabase = createClient();

    const channel = supabase
      .channel(`reactions:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;

          setReactions((prev) => {
            if (prev.some((r) => r.id === row.id)) {
              return prev;
            }

            const tempIdx = prev.findIndex(
              (r) =>
                r.id.startsWith("temp-") &&
                r.message_id === row.message_id &&
                r.actor_type === row.actor_type &&
                r.actor_id === row.actor_id,
            );

            if (tempIdx >= 0) {
              const copy = prev.slice();
              copy[tempIdx] = row;
              return copy;
            }

            return [...prev, row];
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;

          setReactions((prev) =>
            prev.map((r) => (r.id === row.id ? row : r)),
          );
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const old = payload.old as Partial<MessageReaction>;

          if (!old?.id) return;

          setReactions((prev) =>
            prev.filter((r) => r.id !== old.id),
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  useEffect(() => {
    setReplyTo(null);
  }, [conversationId]);

  /*
   * Escape closes the currently selected conversation.
   *
   * Capture phase is intentional: it makes the shortcut work even when
   * focus is inside the message area or another child component.
   *
   * We don't close the conversation while the user is editing text in an
   * input/textarea/contenteditable element, and we allow open dialogs and
   * dropdowns to consume Escape first.
   */
  useEffect(() => {
    if (!conversation || !onBack) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      const target = event.target as HTMLElement | null;

      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }

      const activeOverlay = document.querySelector(
        '[role="dialog"], [data-radix-popper-content-wrapper], [data-radix-menu-content]',
      );

      if (activeOverlay) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      onBack();
    };

    document.addEventListener("keydown", handleEscape, true);

    return () => {
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, [conversation, onBack]);

  useEffect(() => {
    if (!conversationId || !hasUnread) return;

    const supabase = createClient();

    supabase
      .from("conversations")
      .update({
        unread_count: 0,
      })
      .eq("id", conversationId)
      .then(({ error }) => {
        if (error) {
          console.error(
            "Failed to reset unread_count:",
            error,
          );
        }
      });
  }, [conversationId, hasUnread]);

  useEffect(() => {
    if (scrollRef.current) {
      const el = scrollRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleSend = useCallback(
    async (text: string, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "text",
        content_text: text,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };

      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "text",
            content_text: text,
            reply_to_message_id: replyToId,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;

          console.error(
            "Failed to send message:",
            reason,
          );

          toast.error(`Failed to send: ${reason}`);

          onUpdateMessage(tempId, {
            status: "failed",
          });

          return;
        }

        onUpdateMessage(tempId, {
          status: "sent",
        });
      } catch (err) {
        console.error("Failed to send message:", err);

        const reason =
          err instanceof Error
            ? err.message
            : "network error";

        toast.error(`Failed to send: ${reason}`);

        onUpdateMessage(tempId, {
          status: "failed",
        });
      }
    },
    [conversation, onNewMessage, onUpdateMessage],
  );

  const handleSendMedia = useCallback(
    async (payload: SendMediaPayload) => {
      if (!conversation) return;

      const contentText =
        payload.kind === "document"
          ? payload.caption ||
            payload.filename ||
            "Document"
          : payload.caption;

      const tempId = `temp-${Date.now()}`;

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: payload.kind,
        content_text: contentText,
        media_url: payload.mediaUrl,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: payload.replyToId,
      };

      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: payload.kind,
            media_url: payload.mediaUrl,
            content_text: contentText,
            filename: payload.filename,
            reply_to_message_id: payload.replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;

          console.error(
            "Failed to send media:",
            reason,
          );

          toast.error(`Failed to send: ${reason}`);

          onUpdateMessage(tempId, {
            status: "failed",
          });

          void deleteAccountMedia(
            CHAT_MEDIA_BUCKET,
            payload.path,
          ).catch(() => {});

          return;
        }

        onUpdateMessage(tempId, {
          status: "sent",
        });
      } catch (err) {
        console.error("Failed to send media:", err);

        const reason =
          err instanceof Error
            ? err.message
            : "network error";

        toast.error(`Failed to send: ${reason}`);

        onUpdateMessage(tempId, {
          status: "failed",
        });

        void deleteAccountMedia(
          CHAT_MEDIA_BUCKET,
          payload.path,
        ).catch(() => {});
      }
    },
    [conversation, onNewMessage, onUpdateMessage],
  );

  const handleSendInteractive = useCallback(
    async (
      payload: InteractiveMessagePayload,
      replyToId?: string,
    ) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "interactive",
        content_text: payload.body,
        interactive_payload: payload,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };

      onNewMessage(optimisticMsg);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "interactive",
            interactive_payload: payload,
            reply_to_message_id: replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;

          console.error(
            "Failed to send interactive message:",
            reason,
          );

          toast.error(`Failed to send: ${reason}`);

          onUpdateMessage(tempId, {
            status: "failed",
          });

          return;
        }

        onUpdateMessage(tempId, {
          status: "sent",
        });
      } catch (err) {
        console.error(
          "Failed to send interactive message:",
          err,
        );

        const reason =
          err instanceof Error
            ? err.message
            : "network error";

        toast.error(`Failed to send: ${reason}`);

        onUpdateMessage(tempId, {
          status: "failed",
        });
      }
    },
    [conversation, onNewMessage, onUpdateMessage],
  );

  const handleStatusChange = useCallback(
    async (status: ConversationStatus) => {
      if (!conversation) return;

      const supabase = createClient();

      await supabase
        .from("conversations")
        .update({
          status,
        })
        .eq("id", conversation.id);

      onStatusChange(conversation.id, status);
    },
    [conversation, onStatusChange],
  );

  const handleOpenTemplates = useCallback(() => {
    setTemplateModalOpen(true);
  }, []);

  const handleSendTemplate = useCallback(
    async (
      template: MessageTemplate,
      values: {
        body: string[];
        headerText?: string;
        buttonParams?: Record<number, string>;
      },
    ) => {
      if (!conversation) return;

      const renderedBody = renderTemplateBody(
        template.body_text,
        values.body,
      );

      const tempId = `temp-${Date.now()}`;

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "template",
        content_text: renderedBody,
        template_name: template.name,
        status: "sending",
        created_at: new Date().toISOString(),
      };

      onNewMessage(optimisticMsg);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "template",
            template_name: template.name,
            template_language: template.language,
            template_message_params: {
              body: values.body,
              headerText: values.headerText,
              buttonParams: values.buttonParams,
            },
            template_params: values.body,
            content_text: renderedBody,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;

          console.error(
            "Failed to send template:",
            reason,
          );

          toast.error(
            `Failed to send template: ${reason}`,
          );

          onUpdateMessage(tempId, {
            status: "failed",
          });

          return;
        }

        onUpdateMessage(tempId, {
          status: "sent",
        });
      } catch (err) {
        console.error(
          "Failed to send template:",
          err,
        );

        const reason =
          err instanceof Error
            ? err.message
            : "network error";

        toast.error(
          `Failed to send template: ${reason}`,
        );

        onUpdateMessage(tempId, {
          status: "failed",
        });
      }
    },
    [conversation, onNewMessage, onUpdateMessage],
  );

  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();

    for (const m of messages) {
      map.set(m.id, m);
    }

    return map;
  }, [messages]);

  const mediaGallery = useMemo(
    () => collectMediaGallery(messages),
    [messages],
  );

  const reactionsByMessageId = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();

    for (const r of reactions) {
      const bucket = map.get(r.message_id);

      if (bucket) {
        bucket.push(r);
      } else {
        map.set(r.message_id, [r]);
      }
    }

    return map;
  }, [reactions]);

  const contactDisplayName =
    contact?.name || contact?.phone || "Customer";

  const authorLabelFor = useCallback(
    (m: Message): string => {
      const isAgentMsg =
        m.sender_type === "agent" ||
        m.sender_type === "bot";

      return isAgentMsg
        ? "You"
        : contactDisplayName;
    },
    [contactDisplayName],
  );

  const handleStartReply = useCallback(
    (msg: Message) => {
      setReplyTo({
        id: msg.id,
        authorLabel: authorLabelFor(msg),
        preview: buildReplyPreview(msg, tQuote),
      });
    },
    [authorLabelFor, tQuote],
  );

  const postReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!user?.id || !conversation) {
        console.warn(
          "[reactions] missing user or conversation",
        );
        return;
      }

      if (messageId.startsWith("temp-")) {
        toast.error(
          "Wait for the message to finish sending",
        );
        return;
      }

      const convId = conversation.id;
      const userId = user.id;

      let snapshot: MessageReaction[] = [];

      setReactions((prev) => {
        snapshot = prev;

        const own = prev.find(
          (r) =>
            r.message_id === messageId &&
            r.actor_type === "agent" &&
            r.actor_id === userId,
        );

        if (emoji === "") {
          return own
            ? prev.filter((r) => r !== own)
            : prev;
        }

        if (own) {
          return prev.map((r) =>
            r === own
              ? {
                  ...own,
                  emoji,
                }
              : r,
          );
        }

        return [
          ...prev,
          {
            id: `temp-${Date.now()}`,
            message_id: messageId,
            conversation_id: convId,
            actor_type: "agent",
            actor_id: userId,
            emoji,
            created_at: new Date().toISOString(),
          },
        ];
      });

      try {
        const res = await fetch(
          "/api/whatsapp/react",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message_id: messageId,
              emoji,
            }),
          },
        );

        if (!res.ok) {
          const payload = await res
            .json()
            .catch(() => ({}));

          throw new Error(
            payload?.error ||
              `HTTP ${res.status}`,
          );
        }
      } catch (err) {
        const reason =
          err instanceof Error
            ? err.message
            : "network error";

        toast.error(
          `Reaction failed: ${reason}`,
        );

        setReactions(snapshot);
      }
    },
    [conversation, user?.id],
  );

  const handleAssignChange = useCallback(
    async (agentId: string | null) => {
      if (!conversation) return;

      const supabase = createClient();

      const { error } = await supabase
        .from("conversations")
        .update({
          assigned_agent_id: agentId,
        })
        .eq("id", conversation.id);

      if (error) {
        console.error(
          "Failed to update assignment:",
          error,
        );

        toast.error(
          "Failed to update assignment",
        );

        return;
      }

      onAssignChange(
        conversation.id,
        agentId,
      );
    },
    [conversation, onAssignChange],
  );

  if (!conversation || !contact) {
    return (
      <div
        className={cn(
          "flex flex-1 flex-col items-center justify-center",
          DOODLE_BG_CLASSES,
        )}
      >
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <MessageSquare className="h-8 w-8 text-muted-foreground" />
        </div>

        <h3 className="mt-4 text-sm font-medium text-muted-foreground">
          {t("selectConversation")}
        </h3>

        <p className="mt-1 text-xs text-muted-foreground">
          {t("selectConversationHint")}
        </p>
      </div>
    );
  }

  const displayName =
    contact.name || contact.phone;

  const messageGroups =
    groupMessagesByDate(messages);

  const currentStatus =
    STATUS_OPTIONS.find(
      (s) => s.value === conversation.status,
    );

  const assignedAgentId =
    conversation.assigned_agent_id ?? null;

  const currentAssignee =
    profiles.find(
      (p) => p.user_id === assignedAgentId,
    );

  const assignLabel = assignedAgentId
    ? currentAssignee?.full_name ??
      t("assigned")
    : t("assign");

  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col",
        DOODLE_BG_CLASSES,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t("backToConversations")}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}

          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
            {displayName
              .charAt(0)
              .toUpperCase()}
          </div>

          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {displayName}
            </h2>

            <p className="truncate text-xs text-muted-foreground">
              {contact.phone}
            </p>
          </div>

          <Badge
            variant="outline"
            className={cn(
              "ml-1 hidden gap-1 border-border text-[10px] sm:inline-flex sm:ml-2",
              sessionInfo.expired
                ? "text-red-400"
                : "text-primary",
            )}
          >
            <Clock className="h-3 w-3" />
            {sessionInfo.remaining}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {onToggleContactPanel && (
            <button
              type="button"
              onClick={onToggleContactPanel}
              aria-label={
                contactPanelOpen
                  ? t("hideContactPanel")
                  : t("showContactPanel")
              }
              title={
                contactPanelOpen
                  ? t("hideContact")
                  : t("showContact")
              }
              aria-pressed={contactPanelOpen}
              className={cn(
                "hidden h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground lg:inline-flex",
                contactPanelOpen
                  ? "text-primary"
                  : "text-muted-foreground",
              )}
            >
              {contactPanelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </button>
          )}

          {onRefresh && (
            <button
              type="button"
              onClick={handleRefreshClick}
              disabled={isRefreshing}
              aria-label={t(
                "refreshConversation",
              )}
              title={t("refresh")}
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60",
              )}
            >
              <RefreshCw
                className={cn(
                  "h-3.5 w-3.5",
                  isRefreshing &&
                    "animate-spin",
                )}
              />
            </button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                currentStatus?.color ??
                  "text-muted-foreground",
              )}
            >
              {currentStatus
                ? t(
                    `status${currentStatus.label}`,
                  )
                : t("status")}

              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>

            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              {STATUS_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() =>
                    handleStatusChange(
                      opt.value,
                    )
                  }
                  className={cn(
                    "text-sm",
                    opt.color,
                  )}
                >
                  {t(
                    `status${opt.label}`,
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                assignedAgentId
                  ? "text-primary"
                  : "text-muted-foreground",
              )}
            >
              <UserPlus className="h-3 w-3" />

              <span className="hidden sm:inline">
                {assignLabel}
              </span>

              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>

            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              {profiles.length === 0 ? (
                <DropdownMenuItem
                  disabled
                  className="text-sm text-muted-foreground"
                >
                  {t("noTeammates")}
                </DropdownMenuItem>
              ) : (
                profiles.map((p) => {
                  const isSelected =
                    p.user_id ===
                    assignedAgentId;

                  const presence =
                    getPresence(
                      p.user_id,
                    );

                  return (
                    <DropdownMenuItem
                      key={p.id}
                      onClick={() =>
                        handleAssignChange(
                          p.user_id,
                        )
                      }
                      className={cn(
                        "text-sm",
                        isSelected
                          ? "text-primary"
                          : "text-popover-foreground",
                      )}
                    >
                      <PresenceDot
                        status={presence}
                        label={presenceLabel(
                          presence,
                          getRow(
                            p.user_id,
                          )?.last_seen_at ??
                            null,
                          now,
                        )}
                        className="mr-2"
                      />

                      <span className="flex-1">
                        {p.full_name}

                        {p.user_id ===
                          user?.id &&
                          t("me")}
                      </span>

                      {isSelected && (
                        <Check className="ml-2 h-3 w-3" />
                      )}
                    </DropdownMenuItem>
                  );
                })
              )}

              {assignedAgentId && (
                <>
                  <DropdownMenuSeparator className="bg-border" />

                  <DropdownMenuItem
                    onClick={() =>
                      handleAssignChange(
                        null,
                      )
                    }
                    className="text-sm text-muted-foreground"
                  >
                    {t("unassign")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">
              {t("noMessagesYet")}
            </p>

            <p className="text-xs text-muted-foreground">
              {t("sendTemplateHint")}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {messageGroups.map((group) => (
              <div key={group.date}>
                <div className="mb-4 flex items-center justify-center">
                  <span className="rounded-full bg-muted px-3 py-1 text-[10px] font-medium text-muted-foreground">
                    {formatDateSeparator(
                      group.date,
                      t,
                    )}
                  </span>
                </div>

                <div className="space-y-2">
                  {group.messages.map(
                    (msg) => {
                      const parent =
                        msg.reply_to_message_id
                          ? messagesById.get(
                              msg.reply_to_message_id,
                            )
                          : null;

                      const reply = parent
                        ? {
                            authorLabel:
                              parent.sender_type ===
                                "agent" ||
                              parent.sender_type ===
                                "bot"
                                ? t("me")
                                : contact?.name ||
                                  contact?.phone ||
                                  "Unknown",

                            preview:
                              buildReplyPreview(
                                parent,
                                tQuote,
                              ),
                          }
                        : null;

                      const msgReactions =
                        reactionsByMessageId.get(
                          msg.id,
                        );

                      const handlePillToggle = (
                        emoji: string,
                      ) => {
                        const own =
                          msgReactions?.find(
                            (r) =>
                              r.actor_type ===
                                "agent" &&
                              r.actor_id ===
                                user?.id,
                          );

                        const next =
                          own?.emoji === emoji
                            ? ""
                            : emoji;

                        void postReaction(
                          msg.id,
                          next,
                        );
                      };

                      return (
                        <MessageActions
                          key={msg.id}
                          message={msg}
                          onReply={() =>
                            handleStartReply(
                              msg,
                            )
                          }
                          onReact={(emoji) => {
                            if (emoji) {
                              void postReaction(
                                msg.id,
                                emoji,
                              );
                            }
                          }}
                        >
                          <MessageBubble
                            message={msg}
                            reply={reply}
                            reactions={
                              msgReactions
                            }
                            currentUserId={
                              user?.id
                            }
                            onToggleReaction={
                              handlePillToggle
                            }
                            onOpenMedia={
                              handleMediaChange
                            }
                          />
                        </MessageActions>
                      );
                    },
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <AiThreadBanner
        conversationId={
          conversation.id
        }
        disabled={
          conversation.ai_autoreply_disabled ??
          false
        }
        handoffSummary={
          conversation.ai_handoff_summary
        }
        assignedAgentId={
          assignedAgentId
        }
        currentUserId={user?.id}
        onChange={(patch) => {
          if (
            "assigned_agent_id" in
            patch
          ) {
            onAssignChange(
              conversation.id,
              patch.assigned_agent_id ??
                null,
            );
          }
        }}
      />

      <MessageComposer
        conversationId={
          conversation.id
        }
        sessionExpired={
          sessionInfo.expired
        }
        onSend={handleSend}
        onSendMedia={
          handleSendMedia
        }
        onSendInteractive={
          handleSendInteractive
        }
        onOpenTemplates={
          handleOpenTemplates
        }
        replyTo={replyTo}
        onClearReply={() =>
          setReplyTo(null)
        }
      />

      <TemplatePicker
        open={templateModalOpen}
        onOpenChange={
          setTemplateModalOpen
        }
        onSelect={
          handleSendTemplate
        }
      />

      <MediaLightbox
        items={mediaGallery}
        activeId={mediaMessageId}
        onActiveIdChange={
          handleMediaChange
        }
        contactLabel={
          contactDisplayName
        }
      />
    </div>
  );
}