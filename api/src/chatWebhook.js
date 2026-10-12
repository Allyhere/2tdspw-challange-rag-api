const MAX_BACKOFF_MS = 5 * 60 * 1000;

export function webhookBackoffMs(attempts) {
  const exponent = Math.min(Math.max(attempts - 1, 0), 8);
  return Math.min(1000 * 2 ** exponent, MAX_BACKOFF_MS);
}

export function createChatWebhookWorker({
  store,
  url,
  secret,
  fetchImpl = fetch,
  intervalMs = 2000,
  now = () => new Date(),
  limit = 20,
} = {}) {
  let timer = null;
  let running = false;

  async function tick() {
    if (running || !url) return;
    running = true;
    try {
      const jobs = await store.listDueWebhooks(now().toISOString(), limit);
      for (const job of jobs) {
        try {
          const response = await fetchImpl(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-chat-webhook-secret": secret ?? "",
            },
            body: JSON.stringify(job.body),
          });
          if (!response.ok) {
            throw new Error(`Webhook respondeu ${response.status}`);
          }
          await store.markWebhookDelivered(job.id);
        } catch (error) {
          const attempts = (job.attempts ?? 0) + 1;
          const nextAttemptAt = new Date(
            now().getTime() + webhookBackoffMs(attempts),
          ).toISOString();
          await store.deferWebhook(job.id, nextAttemptAt, attempts);
          console.warn("Webhook de chat adiado:", error.message);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer || !url) return;
      const run = () => {
        tick().catch((error) => console.error("Webhook de chat falhou:", error));
      };
      run();
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
