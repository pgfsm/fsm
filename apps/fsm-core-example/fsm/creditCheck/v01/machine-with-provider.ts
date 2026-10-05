import { fromPromise, setup } from "xstate";
import { checkBureau } from "../../../../../test-apps/debug-only/async-worker/typescript/creditCheck/v01/actors/checkBureau/checkBureau.ts";
import { checkReportsTable } from "../../../../../test-apps/debug-only/async-worker/typescript/creditCheck/v01/actors/checkReportsTable/checkReportsTable.ts";
import { determineMiddleScore } from "../../../../../test-apps/debug-only/async-worker/typescript/creditCheck/v01/actors/determineMiddleScore/determineMiddleScore.ts";
import { generateInterestRates } from "../../../../../test-apps/debug-only/async-worker/typescript/creditCheck/v01/actors/generateInterestRates/generateInterestRates.ts";
import { verifyCredentials } from "../../../../../test-apps/debug-only/async-worker/typescript/creditCheck/v01/actors/verifyCredentials/verifyCredentials.ts";

import { assignEquiGavinScore } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/assignEquiGavinScore/assignEquiGavinScore.ts";
import { assignEquiGavinScoreFetch } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/assignEquiGavinScoreFetch/assignEquiGavinScoreFetch.ts";
import { assignErrorMessage } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/assignErrorMessage/assignErrorMessage.ts";
import { assignFirstName } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/assignFirstName/assignFirstName.ts";
import { assignGavperianScore } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/assignGavperianScore/assignGavperianScore.ts";
import { assignGavperianScoreFetch } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/assignGavperianScoreFetch/assignGavperianScoreFetch.ts";
import { assignGavUnionScore } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/assignGavUnionScore/assignGavUnionScore.ts";
import { assignGavUnionScoreFetch } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/assignGavUnionScoreFetch/assignGavUnionScoreFetch.ts";
import { assignInterestRateOptions } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/assignInterestRateOptions/assignInterestRateOptions.ts";
import { assignLastName } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/assignLastName/assignLastName.ts";
import { assignMiddleScore } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/assignMiddleScore/assignMiddleScore.ts";
import { assignSSN } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/assignSSN/assignSSN.ts";
import { emailSalesTeam } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/emailSalesTeam/emailSalesTeam.ts";
import { emailUser } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/emailUser/emailUser.ts";
import { saveCreditProfile } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/saveCreditProfile/saveCreditProfile.ts";
import { saveReportEquiGavin } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/saveReportEquiGavin/saveReportEquiGavin.ts";
import { saveReportGavperian } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/saveReportGavperian/saveReportGavperian.ts";
import { saveReportGavUnion } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/actions/saveReportGavUnion/saveReportGavUnion.ts";

import { allSucceeded } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/guards/allSucceeded/allSucceeded.ts";
import { equiGavinReportFound } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/guards/equiGavinReportFound/equiGavinReportFound.ts";
import { gavperianReportFound } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/guards/gavperianReportFound/gavperianReportFound.ts";
import { gavUnionReportFound } from "../../../../../test-apps/debug-only/sync-worker/typescript/creditCheck/v01/guards/gavUnionReportFound/gavUnionReportFound.ts";
import { machine } from "./machine.ts";
export const machineWithProvider = machine.provide({
  // types: {

  //   context: {} as {
  //     SSN: string;
  //     FirstName: string;
  //     LastName: string;
  //     GavUnionScore: number;
  //     EquiGavinScore: number;
  //     GavperianScore: number;
  //     ErrorMessage: string;
  //     MiddleScore: number;
  //     InterestRateOptions: number[];
  //   },
  // },

  actors: {
    verifyCredentials: fromPromise(
      async (
        { input }: {
          input: { SSN: string; firstName: string; lastName: string };
        },
      ) => await verifyCredentials(input),
    ),
    checkReportsTable: fromPromise(
      async ({ input }: { input: { ssn: string; bureauName: string } }) =>
        await checkReportsTable(input),
    ),
    // gavUnionDBActor's invoke src was renamed to "CheckReportsTable" in
    // machine.ts (the go-language variant of this same actor, exported so
    // worker-sdk/go can link it — see
    // test-apps/debug-only/async-worker/go/creditCheck/v01/actors/CheckReportsTable/CheckReportsTable.go).
    // This harness only ever runs the typescript implementation regardless
    // of asyncOperationLanguage, so it still resolves to the same checkReportsTable.ts
    // function under the new key.
    CheckReportsTable: fromPromise(
      async ({ input }: { input: { ssn: string; bureauName: string } }) =>
        await checkReportsTable(input),
    ),
    checkBureau: fromPromise(
      async ({ input }: { input: { ssn: string; bureauName: string } }) =>
        await checkBureau(input),
    ),
    // equiGavinFetchActor's invoke src was renamed to "checkBureauRust" in
    // machine.ts (the rust-language variant of this same actor — see
    // test-apps/debug-only/async-worker/rust/creditCheck/v01/actors/checkBureauRust/checkBureauRust.rs).
    // This harness only ever runs the typescript implementation regardless
    // of asyncOperationLanguage, so it still resolves to the same checkBureau.ts
    // function under the new key.
    checkBureauRust: fromPromise(
      async ({ input }: { input: { ssn: string; bureauName: string } }) =>
        await checkBureau(input),
    ),
    determineMiddleScore: fromPromise(
      async ({ input }: { input: number[] }) =>
        await determineMiddleScore(input),
    ),
    generateInterestRates: fromPromise(
      async ({ input }: { input: number }) =>
        await generateInterestRates(input),
    ),
  },

  actions: {
    assignSSN,
    assignFirstName,
    assignLastName,
    assignErrorMessage,
    assignEquiGavinScore,
    assignEquiGavinScoreFetch,
    assignGavUnionScore,
    assignGavUnionScoreFetch,
    assignGavperianScore,
    assignGavperianScoreFetch,
    assignMiddleScore,
    assignInterestRateOptions,
    saveReportEquiGavin,
    saveReportGavUnion,
    saveReportGavperian,
    saveCreditProfile,
    emailUser,
    emailSalesTeam,
    // assignCreditScoreError,
  },

  guards: {
    allSucceeded,
    gavUnionReportFound,
    equiGavinReportFound,
    gavperianReportFound,
  },
});
