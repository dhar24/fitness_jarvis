import { supabase } from "./supabase";
import { clearProfile } from "./log";

export async function setUpNewHousehold({ householdName, displayName, weightKg }) {
  const { error } = await supabase.rpc("bootstrap_household", {
    p_household_name: householdName || "Home",
    p_display_name: displayName,
    p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
    p_weight_kg: weightKg ? Number(weightKg) : null,
  });

  if (error) throw error;
  clearProfile();
}

export async function joinWithCode({ code, displayName, weightKg }) {
  const { error } = await supabase.rpc("join_household", {
    p_code: code.trim(),
    p_display_name: displayName,
    p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
    p_weight_kg: weightKg ? Number(weightKg) : null,
  });

  if (error) throw error;
  clearProfile();
}

export async function createInvite() {
  const { data, error } = await supabase.rpc("create_invite");
  if (error) throw error;
  return data;
}

export async function householdMembers() {
  const { data, error } = await supabase
    .from("app_user")
    .select("id, display_name, role")
    .order("display_name");

  if (error) throw error;
  return data ?? [];
}

/** Who I currently let see my log. */
export async function sharedWith() {
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("data_share")
    .select("viewer_user_id")
    .eq("owner_user_id", auth?.user?.id);

  if (error) throw error;
  return new Set((data ?? []).map((r) => r.viewer_user_id));
}

export async function shareWith(viewerId, on) {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) throw new Error("Not signed in");

  if (on) {
    const { error } = await supabase
      .from("data_share")
      .upsert({ owner_user_id: auth.user.id, viewer_user_id: viewerId });
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("data_share")
      .delete()
      .eq("owner_user_id", auth.user.id)
      .eq("viewer_user_id", viewerId);
    if (error) throw error;
  }
}