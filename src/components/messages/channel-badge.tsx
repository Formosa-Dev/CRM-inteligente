"use client";

import { cn } from "@/lib/utils";
import type { Channel } from "@/types/chat";

interface ChannelBadgeProps {
  channel: Channel;
  size?: "sm" | "md";
  className?: string;
}

const channelConfig: Record<Channel, { label: string; bg: string; text: string; icon: string }> = {
  whatsapp: {
    label: "WA",
    bg: "bg-emerald-500/20",
    text: "text-emerald-400",
    icon: "M12 2C6.48 2 2 6.48 2 12c0 1.77.46 3.44 1.28 4.9L2 22l5.19-1.36C8.67 21.53 10.28 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2z",
  },
  telegram: {
    label: "TG",
    bg: "bg-sky-500/20",
    text: "text-sky-400",
    icon: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.03-1.99 1.27-5.62 3.72-.53.36-1.01.54-1.44.53-.47-.01-1.38-.27-2.06-.49-.83-.27-1.49-.42-1.43-.88.03-.24.37-.49 1.02-.74 3.99-1.74 6.65-2.89 7.99-3.44 3.8-1.58 4.59-1.86 5.11-1.87.11 0 .37.03.53.17.14.12.18.28.2.45-.01.06.01.24 0 .38z",
  },
  instagram: {
    label: "IG",
    bg: "bg-fuchsia-500/20",
    text: "text-fuchsia-400",
    icon: "M12 2.2c3.2 0 3.6 0 4.9.1 3.3.1 4.8 1.7 4.9 4.9.1 1.3.1 1.6.1 4.8s0 3.6-.1 4.8c-.1 3.2-1.7 4.8-4.9 4.9-1.3.1-1.6.1-4.9.1-3.2 0-3.6 0-4.8-.1-3.3-.1-4.8-1.7-4.9-4.9-.1-1.3-.1-1.6-.1-4.8s0-3.6.1-4.8c.1-3.2 1.7-4.8 4.9-4.9 1.2-.1 1.6-.1 4.8-.1zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 8.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4zm5.2-9.5a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4z",
  },
  facebook: {
    label: "FB",
    bg: "bg-blue-500/20",
    text: "text-blue-400",
    icon: "M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.4v7A10 10 0 0 0 22 12z",
  },
  sms: {
    label: "SMS",
    bg: "bg-amber-500/20",
    text: "text-amber-400",
    icon: "M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z",
  },
  reddit: {
    label: "RD",
    bg: "bg-orange-500/20",
    text: "text-orange-400",
    icon: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM8 12.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm8 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM8.3 15.3c.9 1 2.3 1.5 3.7 1.5s2.8-.5 3.7-1.5l.9.9c-1.2 1.3-2.9 2-4.6 2s-3.4-.7-4.6-2z",
  },
};

export function ChannelBadge({ channel, size = "sm", className }: ChannelBadgeProps) {
  const config = channelConfig[channel];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium",
        config.bg,
        config.text,
        size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2.5 py-0.5 text-xs",
        className
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        className={size === "sm" ? "h-2.5 w-2.5" : "h-3.5 w-3.5"}
      >
        <path d={config.icon} />
      </svg>
      {config.label}
    </span>
  );
}
