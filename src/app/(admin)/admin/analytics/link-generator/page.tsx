"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildWhatsAppLink } from "@/lib/attribution/ref-code";
import { ClipboardCopyIcon, CheckIcon, LinkIcon } from "lucide-react";
import {
  staggerContainer,
  fadeUpSmall,
  fadeUp,
} from "@/lib/animation-variants";

// ─── Constants ────────────────────────────────────────────────────────────────

const PHONE_REGEX = /^[0-9]{10,15}$/;

// ─── Focusable Input ──────────────────────────────────────────────────────────

interface FocusableInputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  id: string;
}

function FocusableInput({ id, ...props }: FocusableInputProps) {
  return (
    <Input
      id={id}
      {...props}
      className="border-primary/15 transition-[box-shadow,border-color] duration-200 focus-visible:border-primary/60 focus-visible:ring-primary/25"
    />
  );
}

// ─── Field ────────────────────────────────────────────────────────────────────

interface FieldProps {
  id: string;
  label: React.ReactNode;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  required?: boolean;
  hint?: React.ReactNode;
  error?: string | null;
}

function Field({
  id,
  label,
  placeholder,
  value,
  onChange,
  onBlur,
  required,
  hint,
  error,
}: FieldProps) {
  return (
    <motion.div className="flex flex-col gap-1.5" variants={fadeUpSmall}>
      <Label htmlFor={id}>{label}</Label>
      <FocusableInput
        id={id}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        required={required}
      />
      <AnimatePresence>
        {error && (
          <motion.p
            key="error"
            variants={fadeUpSmall}
            initial="hidden"
            animate="visible"
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            className="text-xs text-destructive"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
      {hint && !error && (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </motion.div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LinkGeneratorPage() {
  const [campaign, setCampaign] = useState("");
  const [adset, setAdset] = useState("");
  const [ad, setAd] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);

  // Prefill with the business WhatsApp number from agent_config.
  useEffect(() => {
    fetch("/api/business")
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b?.whatsappPhone) setPhone((v) => v || b.whatsappPhone);
      })
      .catch(() =>
        toast.error("No se pudo cargar el teléfono del negocio — ingresalo a mano")
      );
  }, []);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function validatePhone(value: string): boolean {
    if (!PHONE_REGEX.test(value)) {
      setPhoneError("Número inválido. Incluí código de país (ej: 549XXX...)");
      return false;
    }
    setPhoneError(null);
    return true;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!campaign.trim()) return;
    if (!validatePhone(phone)) return;

    // Signed ref codes are minted server-side — the HMAC secret never
    // reaches the client bundle.
    const res = await fetch("/api/admin/ref-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaignId: campaign.trim(),
        adsetId: adset.trim() || "general",
        adId: ad.trim() || "general",
      }),
    });
    if (!res.ok) {
      toast.error("No se pudo generar el código de referido — intentá de nuevo");
      return;
    }

    const { code: refCode } = await res.json();
    const url = buildWhatsAppLink(phone.trim(), refCode);
    setGeneratedUrl(url);
    setCopied(false);
  }

  async function handleCopy() {
    if (!generatedUrl) return;
    try {
      await navigator.clipboard.writeText(generatedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("No se pudo copiar — seleccioná el link a mano");
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      {/* Header */}
      <motion.div
        variants={fadeUpSmall}
        initial="hidden"
        animate="visible"
        className="flex flex-col gap-1"
      >
        <h1
          className="text-2xl font-bold tracking-tight text-gold-gradient"
          style={{ display: "inline-block" }}
        >
          Generador de Links
        </h1>
        <p className="text-sm text-muted-foreground">
          Creá links de WhatsApp con atribución para tus campañas
        </p>
        <div className="mt-2 h-px w-16 rounded-full bg-gradient-to-br from-gold to-gold-bright opacity-60" />
      </motion.div>

      {/* Form card */}
      <motion.div
        className="glass-card card-gold-glow rounded-xl p-6"
        variants={fadeUpSmall}
        initial="hidden"
        animate="visible"
        transition={{ delay: 0.1 }}
      >
        <motion.form
          onSubmit={handleSubmit}
          className="flex flex-col gap-5"
          variants={staggerContainer}
          initial="hidden"
          animate="visible"
        >
          <Field
            id="campaign"
            label={
              <>
                Campaña <span className="text-destructive">*</span>
              </>
            }
            placeholder="ej: hamburguesas-junio"
            value={campaign}
            onChange={setCampaign}
            required
          />

          <Field
            id="adset"
            label={
              <>
                Adset{" "}
                <span className="text-muted-foreground font-normal">
                  (opcional)
                </span>
              </>
            }
            placeholder="ej: mujeres-25-35-formosa"
            value={adset}
            onChange={setAdset}
          />

          <Field
            id="ad"
            label={
              <>
                Ad{" "}
                <span className="text-muted-foreground font-normal">
                  (opcional)
                </span>
              </>
            }
            placeholder="ej: video-carne-oferta"
            value={ad}
            onChange={setAd}
          />

          <Field
            id="phone"
            label={
              <>
                Teléfono <span className="text-destructive">*</span>
              </>
            }
            placeholder="549XXXXXXXXXX"
            value={phone}
            onChange={(v) => {
              setPhone(v);
              if (phoneError) validatePhone(v);
            }}
            onBlur={(e) => validatePhone(e.target.value)}
            error={phoneError}
            hint="Incluí código de país sin el + (ej: 549XXXXXXXXXX)"
          />

          <motion.div variants={fadeUpSmall}>
            <motion.button
              type="submit"
              disabled={!campaign.trim()}
              className="btn-gold flex items-center justify-center gap-2 h-10 px-5 rounded-xl text-sm font-bold uppercase tracking-widest w-full disabled:opacity-50 disabled:cursor-not-allowed"
              whileHover={{ scale: campaign.trim() ? 1.02 : 1 }}
              whileTap={{ scale: campaign.trim() ? 0.98 : 1 }}
              transition={{ type: "spring", stiffness: 400, damping: 20 }}
            >
              <LinkIcon className="size-4" />
              Generar Link
            </motion.button>
          </motion.div>
        </motion.form>
      </motion.div>

      {/* Result */}
      <AnimatePresence>
        {generatedUrl && (
          <motion.div
            key="result"
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            exit={{ opacity: 0, y: 8, transition: { duration: 0.2 } }}
            className="glass-card rounded-xl p-6 flex flex-col gap-4"
          >
            <h2 className="text-sm font-semibold text-primary">
              Link generado
            </h2>

            {/* URL + copy button */}
            <div className="flex items-center gap-2">
              <div
                className="flex-1 rounded-lg px-3 py-2 text-xs text-foreground break-all font-mono bg-muted/40 border border-primary/20"
              >
                {generatedUrl}
              </div>
              <motion.button
                onClick={handleCopy}
                className="shrink-0 flex items-center gap-1.5 h-9 px-3 rounded-lg border border-border text-sm font-medium text-foreground transition-colors hover:bg-muted"
                title="Copiar al portapapeles"
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.96 }}
                transition={{ type: "spring", stiffness: 400, damping: 20 }}
              >
                <AnimatePresence mode="wait">
                  {copied ? (
                    <motion.span
                      key="copied"
                      className="flex items-center gap-1.5"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.18 }}
                    >
                      <CheckIcon className="size-4 text-green-400" />
                      <span className="text-green-400">¡Copiado!</span>
                    </motion.span>
                  ) : (
                    <motion.span
                      key="copy"
                      className="flex items-center gap-1.5"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.18 }}
                    >
                      <ClipboardCopyIcon className="size-4" />
                      <span>Copiar</span>
                    </motion.span>
                  )}
                </AnimatePresence>
              </motion.button>
            </div>

            {/* Attribution preview */}
            <motion.div
              className="rounded-lg px-4 py-3 text-xs text-muted-foreground bg-primary/[0.04] border border-primary/15"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.15 }}
            >
              <span className="font-medium text-foreground">Atribución: </span>
              Campaña:{" "}
              <span className="text-primary">{campaign}</span>
              {adset && (
                <>
                  {" "}
                  | Adset:{" "}
                  <span className="text-primary">{adset}</span>
                </>
              )}
              {ad && (
                <>
                  {" "}
                  | Ad:{" "}
                  <span className="text-primary">{ad}</span>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
