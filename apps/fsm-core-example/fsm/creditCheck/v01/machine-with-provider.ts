import { fromPromise, setup } from "xstate";
import { checkBureau } from "./typescript/actors/checkBureau/checkBureau.ts";
import { checkReportsTable } from "./typescript/actors/checkReportsTable/checkReportsTable.ts";
import { determineMiddleScore } from "./typescript/actors/determineMiddleScore/determineMiddleScore.ts";
import { generateInterestRates } from "./typescript/actors/generateInterestRates/generateInterestRates.ts";
import { verifyCredentials } from "./typescript/actors/verifyCredentials/verifyCredentials.ts";

import {
  assignEquiGavinScore,
  assignEquiGavinScoreFetch,
  assignErrorMessage,
  assignFirstName,
  assignGavperianScore,
  assignGavperianScoreFetch,
  assignGavUnionScore,
  assignGavUnionScoreFetch,
  assignInterestRateOptions,
  assignLastName,
  assignMiddleScore,
  assignSSN,
  emailSalesTeam,
  emailUser,
  saveCreditProfile,
  saveReportEquiGavin,
  saveReportGavperian,
  saveReportGavUnion,
  // assignCreditScoreError,
} from "./typescript/actions/index.ts";

import {
  allSucceeded,
  equiGavinReportFound,
  gavperianReportFound,
  gavUnionReportFound,
} from "./typescript/guards/index.ts";
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
    checkBureau: fromPromise(
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
