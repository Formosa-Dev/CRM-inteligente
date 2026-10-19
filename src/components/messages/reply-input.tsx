"use client";

import { useState, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { Send, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Channel } from "@/types/chat";

interface ReplyInputProps {
  onSend: (message: string) => Promise<void>;
  channel: Channel;
  disabled?: boolean;
  placeholder?: string;
}

const channelLabels: Record<Channel, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  instagram: "Instagram",
  facebook: "Facebook",
  sms: "SMS",
  reddit: "Reddit",
};

export function ReplyInput({
  onSend,
  channel,
  disabled = false,
  placeholder = "Escribí un mensaje...",
}: ReplyInputProps) {
  const [value, setValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || disabled || isSending) return;
    setIsSending(true);
    try {
      await onSend(trimmed);
      // Solo se limpia el borrador cuando el envío salió — si falla queda
      // el texto para reintentar.
      setValue("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "No se pudo enviar el mensaje"
      );
    } finally {
      setIsSending(false);
    }
  }, [value, disabled, isSending, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  };

  const canSend = value.trim().length > 0 && !disabled && !isSending;

  return (
    <div className="px-4 py-3 border-t border-border bg-black/40 backdrop-blur-lg">
      {/* Channel indicator */}
      {isSending && (
        <motion.p
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          className="text-[11px] text-muted-foreground mb-2"
        >
          Enviando por {channelLabels[channel]}...
        </motion.p>
      )}

      <div className="flex items-end gap-2">
        {/* Attach button (disabled) */}
        <button
          disabled
          className="flex-shrink-0 p-2 rounded-lg text-foreground/40 cursor-not-allowed"
          title="Adjuntos no disponible"
        >
          <Paperclip className="h-5 w-5" />
        </button>

        {/* Textarea (1-4 lines) */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className={cn(
            "flex-1 resize-none rounded-xl px-4 py-2.5 text-sm text-foreground",
            "bg-muted/40 border border-border placeholder:text-muted-foreground",
            "focus:outline-none focus:border-primary/40 transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "max-h-[120px]"
          )}
        />

        {/* Send button */}
        <motion.button
          onClick={handleSend}
          disabled={!canSend}
          className={cn(
            "flex-shrink-0 p-2.5 rounded-xl transition-colors",
            canSend
              ? "bg-primary text-primary-foreground hover:bg-gold-bright"
              : "bg-muted/40 text-foreground/40 cursor-not-allowed"
          )}
          whileTap={canSend ? { scale: 0.92 } : undefined}
        >
          <Send className="h-4 w-4" />
        </motion.button>
      </div>
    </div>
  );
}
