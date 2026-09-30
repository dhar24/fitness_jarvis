const explicit = import.meta.env.VITE_API_BASE;

export const API_BASE =
  explicit !== undefined && explicit !== ""
    ? explicit.replace(/\/$/, "")
    : import.meta.env.DEV
      ? "http://localhost:8000"
      : "";

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}