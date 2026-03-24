import dotenv from "dotenv";
import { generateFsmJSONFromFolders } from './generateFsmJSON.ts';

dotenv.config({ path: "./../../.env" });

// const sharedFSMfolderPath = 'packages/fsm-compiler-ts/src/example/sharedFSM';
// const fsmfolderPath = 'packages/fsm-compiler-ts/src/example/fsm';
const sharedFSMfolderPath = 'apps/fsm-core-example/sharedFSM';
const fsmfolderPath = 'apps/fsm-core-example/fsm';

(async () => {
  console.log("=== generateFsmJSON tests ===\n");

  // without showRecommendation (default)
  console.log("--- generate sharedFSM (no recommendation) ---");
  await generateFsmJSONFromFolders(sharedFSMfolderPath, "sharedFsm", []);
  console.log("✅ sharedFSM generated\n");

  console.log("--- generate fsm (no recommendation) ---");
  await generateFsmJSONFromFolders(fsmfolderPath, "fsm", []);
  console.log("✅ fsm generated\n");

  // with showRecommendation = true
  console.log("--- generate sharedFSM (showRecommendation = true) ---");
  await generateFsmJSONFromFolders(sharedFSMfolderPath, "sharedFsm", [], true);
  console.log("✅ sharedFSM generated with recommendation\n");

  console.log("--- generate fsm (showRecommendation = true) ---");
  await generateFsmJSONFromFolders(fsmfolderPath, "fsm", [], true);
  console.log("✅ fsm generated with recommendation\n");

  console.log("=== generateFsmJSON tests complete ===");
})();

