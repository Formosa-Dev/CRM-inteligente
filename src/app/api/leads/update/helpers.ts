import { z } from "zod";

// leads.type is varchar(10) and only "b2b"/"b2c" are meaningful today
// (see broadcast segments). tags is a bounded string list, not raw jsonb.
export const UpdateLeadSchema = z.object({
  id: z
    .union([z.number().int().positive(), z.string().regex(/^\d{1,10}$/)])
    .transform((v) => Number(v))
    .optional(),
  name: z.string().trim().max(255).optional(),
  phone: z.string().max(50).optional(),
  email: z.union([z.literal(""), z.string().email().max(255)]).optional(),
  address: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
  type: z.enum(["b2b", "b2c"]).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
});
