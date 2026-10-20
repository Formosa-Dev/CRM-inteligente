"use client";

import { useActionState } from "react";
import { signIn } from "next-auth/react";
import { motion, AnimatePresence } from "framer-motion";
import { signInAction } from "./actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { AlertCircleIcon, LoaderIcon, LogInIcon } from "lucide-react";
import { staggerContainer, fadeUpSmall } from "@/lib/animation-variants";

const initialState = { error: "" };

const FOCUS_INPUT_CLASSES =
  "border-primary/15 transition-[border-color,box-shadow] duration-200 focus:border-primary/60 focus:shadow-[0_0_0_2px,0_0_12px] focus:shadow-primary/25";

interface FocusableInputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  id: string;
  name: string;
}

function FocusableInput({ id, name, ...props }: FocusableInputProps) {
  return (
    <Input id={id} name={name} className={FOCUS_INPUT_CLASSES} {...props} />
  );
}

export default function LoginForm() {
  const [state, formAction, isPending] = useActionState(signInAction, initialState);

  return (
    <>
    <motion.form
      action={formAction}
      className="flex flex-col gap-4"
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
    >
      {/* Email field */}
      <motion.div className="flex flex-col gap-1.5" variants={fadeUpSmall}>
        <Label htmlFor="email" className="text-foreground/70">
          Email
        </Label>
        <FocusableInput
          id="email"
          name="email"
          type="email"
          placeholder="admin@tu-dominio.com"
          required
          autoComplete="email"
        />
      </motion.div>

      {/* Password field */}
      <motion.div className="flex flex-col gap-1.5" variants={fadeUpSmall}>
        <Label htmlFor="password" className="text-foreground/70">
          Contraseña
        </Label>
        <FocusableInput
          id="password"
          name="password"
          type="password"
          placeholder="••••••••"
          required
          autoComplete="current-password"
        />
      </motion.div>

      {/* Error message — animated with AnimatePresence */}
      <AnimatePresence mode="wait">
        {state?.error && (
          <motion.div
            key="error"
            variants={fadeUpSmall}
            initial="hidden"
            animate="visible"
            exit={{ opacity: 0, y: -6, transition: { duration: 0.2 } }}
            className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/15 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircleIcon className="size-4 shrink-0" />
            <span>{state.error}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Submit button */}
      <motion.div variants={fadeUpSmall} className="mt-2">
        <motion.div
          whileHover={{ scale: isPending ? 1 : 1.02 }}
          whileTap={{ scale: isPending ? 1 : 0.98 }}
          transition={{ type: "spring", stiffness: 400, damping: 20 }}
        >
          <Button
            type="submit"
            disabled={isPending}
            className="btn-gold h-11 w-full rounded-xl font-bold uppercase tracking-widest text-sm"
          >
            {isPending ? (
              <motion.span
                className="flex items-center gap-2"
                animate={{ opacity: [1, 0.6, 1] }}
                transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
              >
                <LoaderIcon className="size-4 animate-spin" />
                Ingresando…
              </motion.span>
            ) : (
              "Ingresar"
            )}
          </Button>
        </motion.div>
      </motion.div>
    </motion.form>

      {/* Separator */}
      <div className="relative my-4 flex items-center gap-3">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-primary/30 to-transparent" />
        <span className="text-xs font-medium uppercase tracking-widest text-primary/60">
          o continuá con
        </span>
        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-primary/30 to-transparent" />
      </div>

      {/* Facebook login */}
      <motion.div variants={fadeUpSmall}>
        <motion.div
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          transition={{ type: "spring", stiffness: 400, damping: 20 }}
        >
          <button
            type="button"
            onClick={() => signIn("facebook", { callbackUrl: "/admin" })}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#1877F2] font-bold uppercase tracking-widest text-sm text-white hover:bg-[#166fe5]"
          >
            <LogInIcon className="size-4" />
            Continuar con Facebook
          </button>
        </motion.div>
      </motion.div>
    </>
  );
}
