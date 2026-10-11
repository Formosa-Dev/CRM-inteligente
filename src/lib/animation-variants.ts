import type { Variants } from "framer-motion";

export function reducedMotionVariant(_original: Variants): Variants {
  return {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { duration: 0.01 } },
  };
}

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.25, 0.1, 0.25, 1] },
  },
};

export const fadeUpSmall: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: "easeOut" },
  },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.5, ease: "easeOut" },
  },
};

export const staggerContainer: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.15,
    },
  },
};

export const cardEntrance: Variants = {
  hidden: { opacity: 0, y: 40, scale: 0.95 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.5, ease: [0.25, 0.1, 0.25, 1] },
  },
};

export const heroEntrance: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.2,
      delayChildren: 0.1,
    },
  },
};

export const heroChild: Variants = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.25, 0.1, 0.25, 1] },
  },
};

/* ─── Premium variants ─── */

export const blurIn: Variants = {
  hidden: { opacity: 0, filter: "blur(10px)", y: 16 },
  visible: {
    opacity: 1,
    filter: "blur(0px)",
    y: 0,
    transition: { duration: 0.7, ease: [0.25, 0.1, 0.25, 1] },
  },
};

export const clipReveal: Variants = {
  hidden: { opacity: 0, clipPath: "inset(12% 6% 12% 6% round 16px)", scale: 0.97 },
  visible: {
    opacity: 1,
    clipPath: "inset(0% 0% 0% 0% round 16px)",
    scale: 1,
    transition: { duration: 0.7, ease: [0.33, 1, 0.68, 1] },
  },
};

export const wordRevealContainer: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.09, delayChildren: 0.1 },
  },
};

export const wordReveal: Variants = {
  hidden: { y: "115%", rotate: 4 },
  visible: {
    y: "0%",
    rotate: 0,
    transition: { duration: 0.65, ease: [0.33, 1, 0.68, 1] },
  },
};

export const pageEnter: Variants = {
  hidden: { opacity: 0, y: 14, filter: "blur(6px)" },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.5, ease: [0.25, 0.1, 0.25, 1] },
  },
};

/* ─── Elevation eases + entrances (ui-redesign) ───
   Extend-only: every variant here pairs with reducedMotionVariant() via
   the useEditorialMotion().variant() helper in storefront/motion.tsx. */

export const expoOut: [number, number, number, number] = [0.16, 1, 0.3, 1];
export const overshoot: [number, number, number, number] = [0.2, 1.2, 0.34, 1];

/** Hero entrance: rise + un-blur on the expo curve (one-shot, not a loop). */
export const riseIn: Variants = {
  hidden: { opacity: 0, y: 26, scale: 0.965, filter: "blur(10px)" },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: { duration: 0.78, ease: expoOut },
  },
};

/** Same rise for dense surfaces — no blur, keeps repaint cheap. */
export const riseInSmall: Variants = {
  hidden: { opacity: 0, y: 14, scale: 0.98 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.6, ease: expoOut },
  },
};

/** Dialog/popover pop with a soft overshoot settle. */
export const popIn: Variants = {
  hidden: { opacity: 0, scale: 0.92 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.5, ease: overshoot },
  },
};

/** Denser stagger for grids/lists (items ~35ms, first delay 180ms). */
export const staggerDense: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.035,
      delayChildren: 0.18,
    },
  },
};
