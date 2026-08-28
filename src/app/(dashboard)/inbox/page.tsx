"use client";

import { Suspense, useState, useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from "@/lib/inbox/conversations";
import type {
  Conversation,
  Message,
  Contact,
  ConversationStatus,
} from "@/types";
import { useRealtime } from "@/hooks/use-realtime";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { ContactSidebar } from "@/components/inbox/contact-sidebar";
import { toast } from "sonner";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

// Remembers the agent's show/hide choice for the desktop contact panel
// across reloads and sessions (device-scoped, like the theme prefs).
const CONTACT_PANEL_STORAGE_KEY = "wacrm:inbox:contact-panel-open";

// `useSearchParams` (the `?c=<id>` deep link below) requires a Suspense
// boundary or the production build bails to CSR and errors out. Thin
// wrapper supplies it; the inner component holds all the inbox state.
export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner />
    </Suspense>
  );
}

function InboxPageInner() {
  const t = useTranslations("Inbox.page");
  const router = useRouter();
  const searchParams = useSearchParams();

  /**
   * `?c=<id>` deep-link support. Used when landing here from the
   * dashboard's recent-conversations list so the right thread opens
   * automatically instead of showing the empty center panel.
   */
  const deepLinkConvId = searchParams.get("c");

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] =
    useState<Conversation | null>(null);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(
    null
  );

  /**
   * Bumped whenever we want children (ConversationList, MessageThread)
   * to refetch from the DB — used as a safety net against missed
   * realtime events. Bumped on WS reconnect and on tab visibility →
   * visible. The initial mount fetches don't depend on this; they fire
   * once on conversationId-change as usual.
   */
  const [resyncToken, setResyncToken] = useState(0);

  /**
   * Whether the desktop contact sidebar (tags / deals / notes) is shown.
   * Defaults to `true` (the historical behaviour) and is restored from
   * localStorage after mount.
   */
  const [contactPanelOpen, setContactPanelOpen] = useState(true);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(CONTACT_PANEL_STORAGE_KEY);

      if (stored !== null) {
        setContactPanelOpen(stored === "true");
      }
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, []);

  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((prev) => {
      const next = !prev;

      try {
        localStorage.setItem(
          CONTACT_PANEL_STORAGE_KEY,
          String(next)
        );
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }

      return next;
    });
  }, []);

  // Fire the deep-link auto-select exactly once per URL.
  const autoSelectedForDeepLinkRef = useRef<string | null>(null);

  // Tracks conversations whose hydrate fetch is currently in flight.
  const hydratingConvIdsRef = useRef<Set<string>>(new Set());

  /**
   * Synchronous mirror of the conversation ids currently in
   * `conversations` state.
   */
  const knownConvIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const next = new Set<string>();

    for (const c of conversations) {
      next.add(c.id);
    }

    knownConvIdsRef.current = next;
  }, [conversations]);

  /**
   * Pull the conversation row with its `contact` joined and merge it
   * into state.
   */
  const hydrateConversation = useCallback(async (convId: string) => {
    if (hydratingConvIdsRef.current.has(convId)) {
      return;
    }

    hydratingConvIdsRef.current.add(convId);

    try {
      const supabase = createClient();

      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .eq("id", convId)
        .maybeSingle();

      if (error) {
        console.error("Failed to hydrate conversation:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });

        return;
      }

      if (!data) {
        return;
      }

      const fetched = normalizeConversation(data);

      setConversations((prev) => {
        const existing = prev.find((c) => c.id === fetched.id);

        if (existing) {
          return prev.map((c) =>
            c.id === fetched.id
              ? {
                  ...c,
                  contact: c.contact ?? fetched.contact,
                }
              : c
          );
        }

        return [fetched, ...prev];
      });
    } finally {
      hydratingConvIdsRef.current.delete(convId);
    }
  }, []);

  // Check WhatsApp connection status on mount.
  useEffect(() => {
    const checkConnection = async () => {
      const supabase = createClient();

      const {
        data: { session },
      } = await supabase.auth.getSession();

      const user = session?.user;

      if (!user) {
        return;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("account_id")
        .eq("user_id", user.id)
        .maybeSingle();

      const accountId = profile?.account_id as string | undefined;

      if (!accountId) {
        setWhatsappConnected(false);
        return;
      }

      const { data } = await supabase
        .from("whatsapp_config")
        .select("status")
        .eq("account_id", accountId)
        .maybeSingle();

      setWhatsappConnected(data?.status === "connected");
    };

    checkConnection();
  }, []);

  // Handle realtime message events.
  const handleMessageEvent = useCallback(
    (event: {
      eventType: string;
      new: Message;
      old: Partial<Message>;
    }) => {
      const newMsg = event.new;

      if (event.eventType === "INSERT") {
        if (
          activeConversation &&
          newMsg.conversation_id === activeConversation.id
        ) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === newMsg.id)) {
              return prev;
            }

            const withoutOptimistic = prev.filter(
              (m) => !m.id.startsWith("temp-")
            );

            return [...withoutOptimistic, newMsg];
          });
        }

        if (knownConvIdsRef.current.has(newMsg.conversation_id)) {
          setConversations((prev) =>
            prev.map((c) =>
              c.id === newMsg.conversation_id
                ? {
                    ...c,
                    last_message_text: newMsg.content_text ?? "",
                    last_message_at: newMsg.created_at,
                    unread_count:
                      activeConversation?.id === newMsg.conversation_id
                        ? 0
                        : c.unread_count + 1,
                  }
                : c
            )
          );
        } else {
          hydrateConversation(newMsg.conversation_id);
        }
      }

      if (event.eventType === "UPDATE") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === newMsg.id
              ? { ...m, ...newMsg }
              : m
          )
        );
      }
    },
    [activeConversation, hydrateConversation]
  );

  // Handle realtime conversation events.
  const handleConversationEvent = useCallback(
    (event: {
      eventType: string;
      new: Conversation;
      old: Partial<Conversation>;
    }) => {
      const conv = event.new;

      if (event.eventType === "INSERT") {
        if (!knownConvIdsRef.current.has(conv.id)) {
          setConversations((prev) => {
            if (prev.some((c) => c.id === conv.id)) {
              return prev;
            }

            return [conv, ...prev];
          });

          hydrateConversation(conv.id);
        }
      }

      if (event.eventType === "UPDATE") {
        if (knownConvIdsRef.current.has(conv.id)) {
          const isActive = activeConversation?.id === conv.id;

          setConversations((prev) =>
            prev.map((c) =>
              c.id === conv.id
                ? {
                    ...c,
                    ...conv,
                    unread_count: isActive
                      ? 0
                      : conv.unread_count,
                  }
                : c
            )
          );
        } else {
          hydrateConversation(conv.id);
        }

        if (
          activeConversation &&
          conv.id === activeConversation.id
        ) {
          setActiveConversation((prev) =>
            prev
              ? { ...prev, ...conv }
              : prev
          );
        }
      }
    },
    [activeConversation, hydrateConversation]
  );

  // Subscribe to realtime.
  const { isConnected } = useRealtime({
    channelName: "inbox-realtime",
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    enabled: true,
  });

  /**
   * Bump resyncToken whenever realtime reconnects after the initial
   * connection.
   */
  const wasConnectedRef = useRef(false);
  const initialConnectDoneRef = useRef(false);

  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) {
      if (initialConnectDoneRef.current) {
        setResyncToken((n) => n + 1);
      } else {
        initialConnectDoneRef.current = true;
      }
    }

    wasConnectedRef.current = isConnected;
  }, [isConnected]);

  /**
   * Refetch when the tab regains visibility.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setResyncToken((n) => n + 1);
      }
    };

    document.addEventListener(
      "visibilitychange",
      onVisibility
    );

    return () => {
      document.removeEventListener(
        "visibilitychange",
        onVisibility
      );
    };
  }, []);

  /**
   * Manual refresh trigger.
   */
  const handleManualRefresh = useCallback(() => {
    setResyncToken((n) => n + 1);
  }, []);

  const handleConversationsLoaded = useCallback(
    (loaded: Conversation[]) => {
      setConversations(loaded);

      if (
        deepLinkConvId &&
        autoSelectedForDeepLinkRef.current !== deepLinkConvId &&
        loaded.length > 0
      ) {
        autoSelectedForDeepLinkRef.current = deepLinkConvId;

        if (activeConversation?.id === deepLinkConvId) {
          return;
        }

        const match = loaded.find(
          (c) => c.id === deepLinkConvId
        );

        if (match) {
          setActiveConversation(match);
          setActiveContact(match.contact ?? null);
          setMessages([]);

          if (match.unread_count > 0) {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === match.id
                  ? { ...c, unread_count: 0 }
                  : c
              )
            );
          }
        }
      }
    },
    [deepLinkConvId, activeConversation?.id]
  );

  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      if (activeConversation?.id === conv.id) {
        return;
      }

      setActiveConversation(conv);
      setActiveContact(conv.contact ?? null);
      setMessages([]);

      setConversations((prev) =>
        prev.map((c) =>
          c.id === conv.id &&
          c.unread_count > 0
            ? { ...c, unread_count: 0 }
            : c
        )
      );

      autoSelectedForDeepLinkRef.current =
        conv.id;

      router.replace(
        `/inbox?c=${conv.id}`,
        { scroll: false }
      );
    },
    [activeConversation?.id, router]
  );

  // Mobile "back" / close conversation.
  const handleCloseConversation = useCallback(() => {
    setActiveConversation(null);
    setActiveContact(null);
    setMessages([]);

    autoSelectedForDeepLinkRef.current = null;

    router.replace(
      "/inbox",
      { scroll: false }
    );
  }, [router]);

  /**
   * ESCAPE
   *
   * When a conversation is open, pressing Escape closes it just like
   * the back action in WhatsApp.
   *
   * We intentionally do not close the conversation when Escape is being
   * handled inside an input, textarea or contenteditable element.
   * This prevents an Escape used while editing text from unexpectedly
   * navigating away from the conversation.
   */
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      if (!activeConversation) {
        return;
      }

      const target = event.target as HTMLElement | null;

      if (target) {
        const tagName = target.tagName.toLowerCase();

        if (
          tagName === "input" ||
          tagName === "textarea" ||
          tagName === "select" ||
          target.isContentEditable
        ) {
          return;
        }
      }

      event.preventDefault();

      handleCloseConversation();
    };

    window.addEventListener(
      "keydown",
      handleEscape
    );

    return () => {
      window.removeEventListener(
        "keydown",
        handleEscape
      );
    };
  }, [
    activeConversation,
    handleCloseConversation,
  ]);

  const handleMessagesLoaded = useCallback(
    (loaded: Message[]) => {
      setMessages(loaded);
    },
    []
  );

  const handleNewMessage = useCallback(
    (msg: Message) => {
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) {
          return prev;
        }

        return [...prev, msg];
      });
    },
    []
  );

  const handleUpdateMessage = useCallback(
    (id: string, updates: Partial<Message>) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id
            ? { ...m, ...updates }
            : m
        )
      );
    },
    []
  );

  const handleStatusChange = useCallback(
    (
      conversationId: string,
      status: ConversationStatus
    ) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? { ...c, status }
            : c
        )
      );

      if (
        activeConversation?.id === conversationId
      ) {
        setActiveConversation((prev) =>
          prev
            ? { ...prev, status }
            : prev
        );
      }
    },
    [activeConversation]
  );

  const handleAssignChange = useCallback(
    (
      conversationId: string,
      assignedAgentId: string | null
    ) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                assigned_agent_id:
                  assignedAgentId ?? undefined,
              }
            : c
        )
      );

      if (
        activeConversation?.id === conversationId
      ) {
        setActiveConversation((prev) =>
          prev
            ? {
                ...prev,
                assigned_agent_id:
                  assignedAgentId ?? undefined,
              }
            : prev
        );
      }
    },
    [activeConversation]
  );

  // On mobile (<lg) we show a SINGLE pane — either the list or the
  // thread — rather than cramming both side-by-side.
  const hasActiveConv = !!activeConversation;

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6">
      {/* WhatsApp connection banner */}
      {whatsappConnected === false && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
          <WifiOff className="h-4 w-4 text-amber-400" />

          <p className="text-xs text-amber-400">
            {t("whatsappNotConnected")}
          </p>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Conversation list */}
        <div
          className={cn(
            "flex h-full flex-1 lg:flex-none",
            hasActiveConv
              ? "hidden lg:flex"
              : "flex"
          )}
        >
          <ConversationList
            activeConversationId={
              activeConversation?.id ?? null
            }
            onSelect={
              handleSelectConversation
            }
            conversations={
              conversations
            }
            onConversationsLoaded={
              handleConversationsLoaded
            }
            resyncToken={
              resyncToken
            }
          />
        </div>

        {/* Center panel: Message thread */}
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 lg:flex",
            hasActiveConv
              ? "flex"
              : "hidden lg:flex"
          )}
        >
          <MessageThread
            conversation={
              activeConversation
            }
            contact={activeContact}
            messages={messages}
            onMessagesLoaded={
              handleMessagesLoaded
            }
            onNewMessage={
              handleNewMessage
            }
            onUpdateMessage={
              handleUpdateMessage
            }
            onStatusChange={
              handleStatusChange
            }
            onAssignChange={
              handleAssignChange
            }
            onBack={
              handleCloseConversation
            }
            resyncToken={
              resyncToken
            }
            onRefresh={
              handleManualRefresh
            }
            contactPanelOpen={
              contactPanelOpen
            }
            onToggleContactPanel={
              handleToggleContactPanel
            }
          />
        </div>

        {/* Right panel: Contact sidebar */}
        {contactPanelOpen && (
          <div className="hidden lg:block">
            <ContactSidebar
              contact={activeContact}
            />
          </div>
        )}
      </div>
    </div>
  );
}