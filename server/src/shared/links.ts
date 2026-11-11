/** The widget only ever opens Hugging Face pages, whatever a tool result contains. */
export function isHubUrl(url: unknown): url is string {
  try {
    const u = new URL(String(url));
    return u.protocol === "https:" && u.hostname === "huggingface.co" && !u.username && !u.password && !u.port;
  } catch {
    return false;
  }
}
