import { useState } from "react";
import { supabase } from "./lib/supabase";

export default function Auth() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  async function submit(mode) {
    if (!email || !password) {
      setError("Enter an email and password to continue.");
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);

    const { data, error: err } =
      mode === "signup"
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });

    if (err) setError(err.message);
    else if (mode === "signup" && !data.session) {
      setNotice("Account created. Confirm your email, then sign in.");
    }

    setBusy(false);
  }

  return (
    <main className="gate">
      <h1 className="gate__title">Say what you ate.</h1>
      <p className="gate__sub">A spoken log of food and movement, one account per person.</p>

      <input
        className="field"
        type="email"
        autoComplete="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        className="field"
        type="password"
        autoComplete="current-password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      <div className="row" style={{ marginTop: "0.75rem" }}>
        <button className="btn" disabled={busy} onClick={() => submit("signin")}>
          Sign in
        </button>
        <button className="btn btn--quiet" disabled={busy} onClick={() => submit("signup")}>
          Create account
        </button>
      </div>

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
    </main>
  );
}
