// Team alerts and a minimal command channel over the Telegram Bot API. The bot token is a secret: it is
// read from env, never logged (URLs are redacted), and commands are accepted only from allowed chat ids.
export interface TelegramConfig {
  token: string;
  chatId: string;
  /** Chats allowed to send commands (defaults to chatId). */
  allowedChatIds: string[];
}

export function telegramFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  const allowed = (env.TELEGRAM_ALLOWED_CHAT_IDS ?? chatId)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { token, chatId, allowedChatIds: allowed };
}

export class Telegram {
  private offset = 0;
  constructor(
    private readonly c: TelegramConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(method: string) {
    return `https://api.telegram.org/bot${this.c.token}/${method}`;
  }

  async send(text: string): Promise<void> {
    const res = await this.fetchImpl(this.url("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: this.c.chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`telegram sendMessage ${res.status}`); // status only: never echo the URL
  }

  /** Long-poll for commands. Returns only messages from allowed chats that start with '/'. */
  async poll(timeoutSec = 25): Promise<Array<{ chatId: string; from: string; text: string }>> {
    const res = await this.fetchImpl(this.url(`getUpdates?timeout=${timeoutSec}&offset=${this.offset}`), {
      signal: AbortSignal.timeout((timeoutSec + 10) * 1000),
    });
    if (!res.ok) throw new Error(`telegram getUpdates ${res.status}`);
    const body = (await res.json()) as {
      result?: Array<{
        update_id: number;
        message?: { chat: { id: number }; from?: { username?: string; id: number }; text?: string };
      }>;
    };
    const out: Array<{ chatId: string; from: string; text: string }> = [];
    for (const u of body.result ?? []) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      const m = u.message;
      if (!m?.text?.startsWith("/")) continue;
      const chatId = String(m.chat.id);
      if (!this.c.allowedChatIds.includes(chatId)) continue;
      out.push({ chatId, from: m.from?.username ?? String(m.from?.id ?? "?"), text: m.text.trim() });
    }
    return out;
  }
}

export type Command =
  | { kind: "kill"; reason: string }
  | { kind: "resume"; slug: string }
  | { kind: "status" }
  | { kind: "unknown"; text: string };

export function parseCommand(text: string): Command {
  const [cmd, ...rest] = text.replace(/@\w+/, "").split(/\s+/);
  switch (cmd) {
    case "/kill":
      return { kind: "kill", reason: rest.join(" ") || "manual kill from Telegram" };
    case "/resume":
      return rest[0] ? { kind: "resume", slug: rest[0] } : { kind: "unknown", text };
    case "/status":
      return { kind: "status" };
    default:
      return { kind: "unknown", text };
  }
}
