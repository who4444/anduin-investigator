import { ensureFakeLlm } from "./fake-llm";

export default async function globalSetup(): Promise<void> {
  await ensureFakeLlm();
}
