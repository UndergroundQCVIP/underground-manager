/**
 * LA CONFRÉRIE — Deno KV Connection Management
 */

let kvInstance: Deno.Kv | null = null;

export async function getKv(): Promise<Deno.Kv> {
  if (!kvInstance) {
    // If running in test or local without Deno Deploy KV URL,
    // openKv() opens default local KV or path
    kvInstance = await Deno.openKv();
  }
  return kvInstance;
}

export function setKvForTesting(kv: Deno.Kv | null): void {
  kvInstance = kv;
}

export async function closeKv(): Promise<void> {
  if (kvInstance) {
    await kvInstance.close();
    kvInstance = null;
  }
}
