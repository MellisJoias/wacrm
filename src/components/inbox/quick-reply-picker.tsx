"use client";

import {
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import {
  Loader2,
  MessageSquare,
  Zap,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { QuickReply } from "@/types";
import { interactivePayloadPreviewText } from "@/lib/whatsapp/interactive";

interface QuickReplyPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (qr: QuickReply) => void;

  /**
   * Quando true, o picker aparece acima
   * do textarea, como autocomplete.
   */
  inline?: boolean;

  /**
   * Texto depois da barra.
   *
   * Exemplo:
   *
   * /cadastro
   *
   * query = "cadastro"
   */
  query?: string;
}

export function QuickReplyPicker({
  open,
  onOpenChange,
  onPick,
  inline = false,
  query = "",
}: QuickReplyPickerProps) {
  const t = useTranslations("Inbox.composer");

  const [items, setItems] =
    useState<QuickReply[]>([]);

  const [loading, setLoading] =
    useState(false);

  const [search, setSearch] =
    useState("");

  const [createOpen, setCreateOpen] =
    useState(false);

  const [saving, setSaving] =
    useState(false);

  const [title, setTitle] =
    useState("");

  const [content, setContent] =
    useState("");

  const [highlightedIndex, setHighlightedIndex] =
    useState(0);

  const listRef =
    useRef<HTMLDivElement>(null);

  // ------------------------------------------------------------------
  // LOAD
  // ------------------------------------------------------------------

  const loadQuickReplies =
    useCallback(async () => {
      setLoading(true);

      try {
        const res =
          await fetch(
            "/api/quick-replies",
            {
              cache: "no-store",
            }
          );

        const data =
          await res
            .json()
            .catch(() => ({}));

        if (!res.ok) {
          toast.error(
            data.error ??
              "Não foi possível carregar as respostas rápidas."
          );

          return;
        }

        setItems(
          (data.quick_replies as QuickReply[]) ??
            []
        );
      } catch {
        toast.error(
          "Não foi possível carregar as respostas rápidas."
        );
      } finally {
        setLoading(false);
      }
    }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    /*
     * Quando abre pelo slash, usa o query.
     *
     * Quando abre pelo botão, usa o campo
     * de pesquisa independente.
     */
    if (inline) {
      setSearch("");
    } else {
      setSearch("");
    }

    setHighlightedIndex(0);

    void loadQuickReplies();
  }, [
    open,
    inline,
    loadQuickReplies,
  ]);

  // ------------------------------------------------------------------
  // FILTER
  // ------------------------------------------------------------------

  const effectiveSearch =
    inline
      ? query
      : search;

  const filteredItems =
    items.filter((qr) => {
      const q =
        effectiveSearch
          .trim()
          .toLowerCase();

      if (!q) {
        return true;
      }

      const titleText =
        qr.title
          ?.toLowerCase() ?? "";

      const contentText =
        qr.content_text
          ?.toLowerCase() ?? "";

      return (
        titleText.includes(q) ||
        contentText.includes(q)
      );
    });

  /*
   * Garante que o índice selecionado
   * nunca ultrapasse a lista filtrada.
   */
  useEffect(() => {
    if (
      highlightedIndex >=
      filteredItems.length
    ) {
      setHighlightedIndex(
        Math.max(
          0,
          filteredItems.length - 1
        )
      );
    }
  }, [
    filteredItems.length,
    highlightedIndex,
  ]);

  // ------------------------------------------------------------------
  // CREATE
  // ------------------------------------------------------------------

  const handleCreate =
    async () => {
      const cleanTitle =
        title.trim();

      const cleanContent =
        content.trim();

      if (!cleanTitle) {
        toast.error(
          "Digite um nome para a resposta rápida."
        );

        return;
      }

      if (!cleanContent) {
        toast.error(
          "Digite a mensagem da resposta rápida."
        );

        return;
      }

      setSaving(true);

      try {
        const res =
          await fetch(
            "/api/quick-replies",
            {
              method: "POST",
              headers: {
                "Content-Type":
                  "application/json",
              },
              body: JSON.stringify({
                title: cleanTitle,
                kind: "text",
                content_text:
                  cleanContent,
              }),
            }
          );

        const data =
          await res
            .json()
            .catch(() => ({}));

        if (!res.ok) {
          toast.error(
            data.error ??
              "Não foi possível salvar a resposta rápida."
          );

          return;
        }

        const created =
          data.quick_reply as
            | QuickReply
            | undefined;

        if (created) {
          setItems(
            (prev) => [
              created,
              ...prev,
            ]
          );
        } else {
          await loadQuickReplies();
        }

        setTitle("");
        setContent("");
        setCreateOpen(false);

        toast.success(
          "Resposta rápida criada."
        );
      } catch {
        toast.error(
          "Não foi possível salvar a resposta rápida."
        );
      } finally {
        setSaving(false);
      }
    };

  // ------------------------------------------------------------------
  // KEYBOARD
  // ------------------------------------------------------------------

  const handleInlineKeyDown =
    useCallback(
      (event: KeyboardEvent) => {
        if (!open || !inline) {
          return;
        }

        if (
          event.key ===
          "ArrowDown"
        ) {
          event.preventDefault();

          setHighlightedIndex(
            (current) =>
              filteredItems.length ===
              0
                ? 0
                : (current + 1) %
                  filteredItems.length
          );

          return;
        }

        if (
          event.key ===
          "ArrowUp"
        ) {
          event.preventDefault();

          setHighlightedIndex(
            (current) =>
              filteredItems.length ===
              0
                ? 0
                : (current -
                    1 +
                    filteredItems.length) %
                  filteredItems.length
          );

          return;
        }

        if (
          event.key === "Enter" &&
          !event.shiftKey
        ) {
          if (
            filteredItems.length ===
            0
          ) {
            return;
          }

          event.preventDefault();

          const selected =
            filteredItems[
              highlightedIndex
            ];

          if (selected) {
            onPick(selected);
          }

          return;
        }

        if (
          event.key === "Escape"
        ) {
          event.preventDefault();

          onOpenChange(false);
        }
      },
      [
        open,
        inline,
        filteredItems,
        highlightedIndex,
        onPick,
        onOpenChange,
      ]
    );

  /*
   * A navegação do teclado precisa acontecer
   * no textarea. Como este componente não recebe
   * diretamente o evento dele, escutamos os eventos
   * enquanto o modo inline estiver ativo.
   */
  useEffect(() => {
    if (!open || !inline) {
      return;
    }

    const handler =
      (
        event: KeyboardEvent
      ) => {
        handleInlineKeyDown(
          event
        );
      };

    window.addEventListener(
      "keydown",
      handler
    );

    return () => {
      window.removeEventListener(
        "keydown",
        handler
      );
    };
  }, [
    open,
    inline,
    handleInlineKeyDown,
  ]);

  // ------------------------------------------------------------------
  // SCROLL HIGHLIGHTED ITEM INTO VIEW
  // ------------------------------------------------------------------

  useEffect(() => {
    if (!inline) {
      return;
    }

    const container =
      listRef.current;

    if (!container) {
      return;
    }

    const item =
      container.querySelector(
        `[data-quick-reply-index="${highlightedIndex}"]`
      );

    if (
      item instanceof HTMLElement
    ) {
      item.scrollIntoView({
        block: "nearest",
      });
    }
  }, [
    highlightedIndex,
    inline,
  ]);

  // ------------------------------------------------------------------
  // ITEM
  // ------------------------------------------------------------------

  const renderItems =
    () => {
      if (loading) {
        return (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        );
      }

      if (
        filteredItems.length ===
        0
      ) {
        return (
          <div className="py-6 text-center">
            <MessageSquare className="mx-auto mb-2 h-7 w-7 text-muted-foreground/50" />

            <p className="text-xs text-muted-foreground">
              {effectiveSearch.trim()
                ? "Nenhuma resposta encontrada."
                : t(
                    "quickRepliesEmpty"
                  )}
            </p>
          </div>
        );
      }

      return (
        <ul className="flex flex-col gap-1">
          {filteredItems.map(
            (
              qr,
              index
            ) => {
              const highlighted =
                inline &&
                index ===
                  highlightedIndex;

              return (
                <li key={qr.id}>
                  <button
                    type="button"
                    data-quick-reply-index={
                      index
                    }
                    onMouseEnter={() => {
                      if (
                        inline
                      ) {
                        setHighlightedIndex(
                          index
                        );
                      }
                    }}
                    onClick={() =>
                      onPick(qr)
                    }
                    className={[
                      "flex w-full items-start gap-2 rounded-md border p-2.5 text-left transition-colors",
                      highlighted
                        ? "border-primary/50 bg-primary/10"
                        : "border-border bg-muted/40 hover:border-primary/50 hover:bg-muted",
                    ].join(" ")}
                  >
                    {qr.kind ===
                    "interactive" ? (
                      <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    )}

                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {qr.title}
                      </span>

                      <span className="mt-0.5 block whitespace-pre-wrap break-words text-xs text-muted-foreground">
                        {qr.kind ===
                          "interactive" &&
                        qr.interactive_payload
                          ? interactivePayloadPreviewText(
                              qr.interactive_payload
                            )
                          : qr.content_text}
                      </span>
                    </span>
                  </button>
                </li>
              );
            }
          )}
        </ul>
      );
    };

  // ------------------------------------------------------------------
  // INLINE PICKER
  // ------------------------------------------------------------------

  if (inline) {
    if (!open) {
      return null;
    }

    return (
      <div
        className="absolute bottom-full left-0 z-50 mb-2 w-full max-w-md overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
        onMouseDown={(e) =>
          e.preventDefault()
        }
      >
        <div className="border-b border-border px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">
              Respostas rápidas
            </span>

            <span className="text-[10px] text-muted-foreground">
              ↑↓ navegar · Enter selecionar · Esc fechar
            </span>
          </div>

          <div className="mt-1 text-[11px] text-muted-foreground">
            {query
              ? `/${query}`
              : "Digite para pesquisar..."}
          </div>
        </div>

        <div
          ref={listRef}
          className="max-h-64 overflow-y-auto p-1.5"
        >
          {renderItems()}
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // FULL DIALOG
  // ------------------------------------------------------------------

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={
          onOpenChange
        }
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("quickReplies")}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />

              <Input
                value={search}
                onChange={(e) => {
                  setSearch(
                    e.target.value
                  );

                  setHighlightedIndex(
                    0
                  );
                }}
                placeholder="Pesquisar resposta rápida..."
                className="pl-9"
              />
            </div>

            <Button
              type="button"
              variant="outline"
              className="w-full justify-start"
              onClick={() =>
                setCreateOpen(true)
              }
            >
              <Plus className="mr-2 h-4 w-4" />
              Nova resposta rápida
            </Button>

            <div
              ref={listRef}
              className="max-h-[50vh] overflow-y-auto"
            >
              {renderItems()}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={createOpen}
        onOpenChange={
          setCreateOpen
        }
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Nova resposta rápida
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                Nome
              </label>

              <Input
                value={title}
                onChange={(e) =>
                  setTitle(
                    e.target.value
                  )
                }
                placeholder="Ex.: Apresentação do consignado"
                disabled={saving}
                autoFocus
              />

              <p className="text-xs text-muted-foreground">
                Esse nome será usado para localizar a
                resposta rapidamente.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                Mensagem
              </label>

              <textarea
                value={content}
                onChange={(e) =>
                  setContent(
                    e.target.value
                  )
                }
                placeholder="Digite a mensagem que deseja reutilizar..."
                disabled={saving}
                rows={6}
                className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
              />

              <p className="text-xs text-muted-foreground">
                A mensagem será inserida na conversa para
                você revisar antes de enviar.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() =>
                setCreateOpen(false)
              }
            >
              Cancelar
            </Button>

            <Button
              type="button"
              disabled={
                saving ||
                !title.trim() ||
                !content.trim()
              }
              onClick={() =>
                void handleCreate()
              }
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Salvando...
                </>
              ) : (
                <>
                  <Plus className="mr-2 h-4 w-4" />
                  Salvar resposta
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}