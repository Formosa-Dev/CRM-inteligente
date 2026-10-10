"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { useScroll, useTransform, motion, type MotionValue } from "framer-motion";
import { BackgroundCycle } from "./background-cycle";
import { BG_IMAGES } from "@/lib/constants";

function getParallaxSnapshot() {
  return (
    window.matchMedia("(min-width: 768px)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function subscribeParallax(onChange: () => void) {
  const mq = window.matchMedia("(min-width: 768px)");
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", onChange);
  prefersReduced.addEventListener("change", onChange);
  return () => {
    mq.removeEventListener("change", onChange);
    prefersReduced.removeEventListener("change", onChange);
  };
}

export function HeroParallax({ children }: { children: ReactNode }) {
  const parallaxEnabled = useSyncExternalStore(
    subscribeParallax,
    getParallaxSnapshot,
    () => false,
  );

  const { scrollY } = useScroll();
  const yRaw = useTransform(scrollY, [0, 500], [0, 30]);
  const opacityRaw = useTransform(scrollY, [0, 400], [1, 0.6]);

  // When parallax is off, use static values
  const y = parallaxEnabled ? yRaw : (0 as unknown as MotionValue<number>);
  const opacity = parallaxEnabled
    ? opacityRaw
    : (1 as unknown as MotionValue<number>);

  return (
    <section className="relative flex flex-col items-center justify-center min-h-[100svh] text-center px-4 overflow-hidden w-full" style={{ maxWidth: "100vw" }}>
      <motion.div className="absolute inset-0" style={{ y }}>
        <BackgroundCycle images={BG_IMAGES} />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(to bottom, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.8) 100%)",
          }}
        />
      </motion.div>

      <div
        className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/4 w-[300px] h-[300px] sm:w-[500px] sm:h-[500px] rounded-full pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(212,160,23,0.07) 0%, transparent 70%)",
          filter: "blur(40px)",
        }}
        aria-hidden="true"
      />

      <motion.div
        className="relative z-10 flex flex-col items-center gap-6 max-w-4xl w-full"
        style={{ opacity }}
      >
        {children}
      </motion.div>
    </section>
  );
}
