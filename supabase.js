import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_KEY;

if (!url || !key) {
  throw new Error("Supabase env vars missing. Check frontend/.env and restart the dev server.");
}

export const supabase = createClient(url, key);