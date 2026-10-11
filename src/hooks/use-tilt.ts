"use client";

import { useState, useCallback, useRef, useSyncExternalStore } from "react";

interface TiltValues {
  rotateX: number;
  rotateY: number;
}

interface UseTiltOptions {
  maxAngle?: number;
  resetOnLeave?: boolean;
}

function subscribeHoverCapability(onChange: () => void) {
  const mq = window.matchMedia("(hover: hover)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function useTilt(options: UseTiltOptions = {}) {
  const { maxAngle = 8, resetOnLeave = true } = options;
  const ref = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState<TiltValues>({ rotateX: 0, rotateY: 0 });
  const isHoverDevice = useSyncExternalStore(
    subscribeHoverCapability,
    () => window.matchMedia("(hover: hover)").matches,
    () => false,
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isHoverDevice || !ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      setTilt({
        rotateX: (y - 0.5) * -maxAngle,
        rotateY: (x - 0.5) * maxAngle,
      });
    },
    [maxAngle, isHoverDevice]
  );

  const onMouseLeave = useCallback(() => {
    if (resetOnLeave) setTilt({ rotateX: 0, rotateY: 0 });
  }, [resetOnLeave]);

  return {
    ref,
    style: {
      transform: `perspective(1000px) rotateX(${tilt.rotateX}deg) rotateY(${tilt.rotateY}deg)`,
      transition: "transform 0.1s ease-out",
    },
    onMouseMove,
    onMouseLeave,
  };
}
