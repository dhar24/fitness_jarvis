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
      setError("Enter an email and password first.");
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);

    const { data, error: err } =
      mode === "signup"
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });

    if (err) {
      setError(err.message);
    } else if (mode === "signup" && !data.session) {
      setNotice("Account created. Check your email to confirm, then sign in.");
    }

    setBusy(false);
  }

  return (
    <main className="shell">
      <header className="head">
        <h1>Sign in</h1>
        <p className="sub">One account per person. Create yours, then sign in.</p>
      </header>

      <div className="panel panel--stack">
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
        <div className="row">
          <button className="mic mic--off" disabled={busy} onClick={() => submit("signin")}>
            Sign in
          </button>
          <button className="mic mic--on" disabled={busy} onClick={() => submit("signup")}>
            Create account
          </button>
        </div>
      </div>

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
    </main>
  );
}