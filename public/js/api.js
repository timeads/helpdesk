export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * help.tuftlife.com sits behind Cloudflare Access. When its sign-in runs out, Access answers our
 * next request with a redirect to its login page on another site, which the browser blocks: fetch
 * throws a bare "Failed to fetch". Ask once more without following redirects: a redirect means
 * the sign-in ran out (not the network), and a reload signs in again via Google.
 */
async function signInRanOut() {
  try {
    const res = await fetch("/api/me", { redirect: "manual", credentials: "same-origin", cache: "no-store" });
    return res.type === "opaqueredirect";
  } catch {
    return false;
  }
}

let signInNotice = null;

/** One notice that stays until used: drafts are saved on this computer, so reloading is safe. */
function showSignInNotice() {
  if (signInNotice?.isConnected) return;
  const btn = document.createElement("button");
  btn.className = "toast-action";
  btn.textContent = "Sign in again";
  btn.onclick = () => location.reload();
  const msg = document.createElement("span");
  msg.textContent = "Your sign-in has run out. Any reply you were writing is saved.";
  signInNotice = document.createElement("div");
  signInNotice.className = "toast err";
  signInNotice.setAttribute("role", "alert");
  signInNotice.append(msg, btn);
  document.getElementById("toasts")?.append(signInNotice);
}

export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch("/api" + path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    if (await signInRanOut()) {
      showSignInNotice();
      throw new ApiError(401, "Your sign-in ran out");
    }
    throw new ApiError(0, "Couldn't reach the support desk. Check your connection and try again");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/me")) location.href = "/";
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  }
  return data;
}
