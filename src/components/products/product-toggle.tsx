"use client";

import { motion } from "framer-motion";

interface ProductToggleProps {
  value: string;
  onChange: (value: string) => void;
  showAll?: boolean;
  options?: { id: string; label: string }[];
}

const DEFAULT_OPTIONS = [{ id: "carne", label: "Línea Carne" }];

export function ProductToggle({ value, onChange, showAll = false, options }: ProductToggleProps) {
  const TABS = [
    ...(showAll ? [{ id: "todas" as const, label: "Todas" }] : []),
    ...(options ?? DEFAULT_OPTIONS),
  ];

  return (
    <div className="relative inline-flex rounded-full p-1 bg-muted/40 border border-border">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`relative px-6 py-2.5 rounded-full text-sm font-semibold transition-colors duration-300 active:scale-[0.98] ${
            value === tab.id ? "text-foreground" : "text-foreground/60 hover:text-foreground/80"
          }`}
        >
          {value === tab.id && (
            <motion.div
              layoutId="toggle-pill"
              className="absolute inset-0 rounded-full border border-border orb-finish"
              transition={{ type: "spring", stiffness: 500, damping: 35 }}
            />
          )}
          <span className="relative z-10">{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
