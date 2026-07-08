import { getLogger } from "@logtape/logtape";
import type { DBDeps } from "@pgfsm/db";
import {
  type ActorReference,
  type OperationLang,
  validateAsyncOperationFromFoldersV2,
  type WorkflowType,
} from "@pgfsm/compiler";
import { createAndStartPromiseWorker } from "./create-and-start-promise-worker.ts";
import type { VerifiedModule } from "./fsmworker.ts";

const logger = getLogger(["@pgfsm/worker", "workerlet"]);

const _srcDir = new URL(".", import.meta.url).pathname;

export type WorkerletRegistration = {
  fnName: string;
  lang: string;
  pid: number | null;
  queueName: string;
  parentFsmName: string;
  parentFsmVersion: string;
  isRegistered: boolean;
  errorMessage: string | null;
};

export async function startAsyncOperationWorkerletsFromFolders(
  deps: DBDeps,
  folderPath: string,
  workflowType: WorkflowType,
  skipDirs: string[] = [],
  availableActors: ActorReference[] = [],
  runtimeLanguages: OperationLang[] = [],
  signal?: AbortSignal,
): Promise<WorkerletRegistration[]> {
  const validationResults = await validateAsyncOperationFromFoldersV2(
    folderPath,
    workflowType,
    skipDirs,
    availableActors,
    runtimeLanguages,
  );

  const registrations: WorkerletRegistration[] = [];

  for (const result of validationResults) {
    if (!result.isVerified) {
      logger.warn("Skipping unverified actor {actor} ({lang})", {
        actor: result.method,
        lang: result.fsmLanguage,
      });
      continue;
    }

    const {
      method: fnName,
      fsmLanguage: lang,
      fsmModulePath: modulePath,
      parentFsmName,
      parentFsmVersion,
      parentFsmPath,
    } = result;

    const queueName = `${parentFsmName}_${fnName}_${parentFsmVersion}`;

    if (lang === "typescript") {
      const verifiedModule: VerifiedModule = {
        fsmAbsFolderPath: `${parentFsmPath}/${parentFsmVersion}`,
        fsmType: "promise",
        fsmParentDirName: parentFsmName,
      };
      try {
        await createAndStartPromiseWorker(
          deps,
          queueName,
          fnName,
          "promise",
          parentFsmVersion,
          verifiedModule,
          signal,
        );
        logger.info(
          "Started TypeScript workerlet for {actor} on queue {queue}",
          { actor: fnName, queue: queueName },
        );
        registrations.push({
          fnName,
          lang,
          pid: null,
          queueName,
          parentFsmName,
          parentFsmVersion,
          isRegistered: true,
          errorMessage: null,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(
          "Failed to start TypeScript workerlet for {actor}: {err}",
          { actor: fnName, err: errorMessage },
        );
        registrations.push({
          fnName,
          lang,
          pid: null,
          queueName,
          parentFsmName,
          parentFsmVersion,
          isRegistered: false,
          errorMessage,
        });
      }
    } else if (lang === "python") {
      const scriptPath = `${_srcDir}create-and-start-promise-worker.py`;
      try {
        const proc = new Deno.Command("python3", {
          args: [
            scriptPath,
            modulePath,
            fnName,
            queueName,
            fnName,
            "promise",
            parentFsmVersion,
          ],
          env: { ...Deno.env.toObject() },
          stdin: "null",
          stdout: "inherit",
          stderr: "inherit",
        }).spawn();
        logger.info(
          "Started Python workerlet for {actor} (PID {pid}) on queue {queue}",
          { actor: fnName, pid: proc.pid, queue: queueName },
        );
        registrations.push({
          fnName,
          lang,
          pid: proc.pid,
          queueName,
          parentFsmName,
          parentFsmVersion,
          isRegistered: true,
          errorMessage: null,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(
          "Failed to start Python workerlet for {actor}: {err}",
          { actor: fnName, err: errorMessage },
        );
        registrations.push({
          fnName,
          lang,
          pid: null,
          queueName,
          parentFsmName,
          parentFsmVersion,
          isRegistered: false,
          errorMessage,
        });
      }
    } else if (lang === "go") {
      logger.warn(
        "Go workerlet registration not yet implemented for {actor}",
        { actor: fnName },
      );
      registrations.push({
        fnName,
        lang,
        pid: null,
        queueName,
        parentFsmName,
        parentFsmVersion,
        isRegistered: false,
        errorMessage: "Go workerlet registration not yet implemented",
      });
    } else if (lang === "rust") {
      logger.warn(
        "Rust workerlet registration not yet implemented for {actor}",
        { actor: fnName },
      );
      registrations.push({
        fnName,
        lang,
        pid: null,
        queueName,
        parentFsmName,
        parentFsmVersion,
        isRegistered: false,
        errorMessage: "Rust workerlet registration not yet implemented",
      });
    }
  }

  return registrations;
}
