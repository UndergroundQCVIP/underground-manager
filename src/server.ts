/**
 * Underground Manager — HTTP request handling for webhook mode.
 * Kept separate from main.ts so authentication behaviour is unit-testable.
 */

const MAX_BODY_BYTES = 1_000_000; // Telegram updates are a few KB

/** Constant-time comparison of the Telegram secret-token header. */
export async function isValidWebhookSecret(
  provided: string | null,
  expected: string
): Promise<boolean> {
  if (!expected || provided === null) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export function createFetchHandler(options: {
  webhookSecret: string;
  handleWebhook: (req: Request) => Promise<Response>;
}): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      // Deliberately minimal: no environment, phase or version details.
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST" && (url.pathname === "/webhook" || url.pathname === "/")) {
      // Fail closed: with no secret configured the endpoint accepts nothing.
      if (!options.webhookSecret) {
        return new Response("Webhook not configured", { status: 503 });
      }
      const header = req.headers.get("x-telegram-bot-api-secret-token");
      if (!(await isValidWebhookSecret(header, options.webhookSecret))) {
        console.warn("[Security] Rejected webhook request with invalid secret token.");
        return new Response("Unauthorized", { status: 401 });
      }

      const declared = Number(req.headers.get("content-length") ?? "0");
      if (declared > MAX_BODY_BYTES) {
        return new Response("Payload Too Large", { status: 413 });
      }

      try {
        return await options.handleWebhook(req);
      } catch (err) {
        console.error("[Webhook Error] Unhandled error processing webhook:", err);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  };
}
