import { stopFakeLlm } from "./fake-llm";

export default async function globalTeardown(): Promise<void> {
  stopFakeLlm();
}
