import { engineContract } from "../src/testing/contract";
import { createFakeEngine } from "../src/testing/fake-engine";

engineContract("fake engine", () => createFakeEngine({ withRunTests: true }), {
  forbiddenNames: ["aqe", "agentic", "understand", "anthropic", "openai"],
});
